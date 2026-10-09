import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CodexAppServer, protocolObject, runtimeEnvironment } from './codex-app-server.js';
import { CodexExecRunner, type CodexExecRunnerOptions } from './codex-exec-runner.js';
import { CodexManagedRuntime } from './codex-managed-runtime.js';
import type { ReviewAgentRunner, ReviewAgentRuntime } from './review-executor.js';

export interface CodexAppServerRunnerOptions extends CodexExecRunnerOptions {
  /** Requires controlled Linux, dedicated-auth and finding-quality evidence before default promotion. */
  enableManagedRuntime?: boolean;
}

export class CodexAppServerRunner implements ReviewAgentRunner {
  readonly #serial: CodexExecRunner;
  readonly #options: CodexAppServerRunnerOptions;

  constructor(options: CodexAppServerRunnerOptions) {
    this.#serial = new CodexExecRunner(options);
    this.#options = { ...options, logger: options.logger ?? console };
  }

  runAgent(input: Parameters<ReviewAgentRunner['runAgent']>[0]) {
    return this.#serial.runAgent(input);
  }

  installDependencies(input: Parameters<CodexExecRunner['installDependencies']>[0]) {
    return this.#serial.installDependencies(input);
  }

  async openReview(
    input: Parameters<NonNullable<ReviewAgentRunner['openReview']>>[0],
  ): Promise<ReviewAgentRuntime> {
    input.signal?.throwIfAborted();
    if (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1)
      throw new Error('Review Agent concurrency must be a positive integer');
    if (this.#options.enableManagedRuntime && input.maxConcurrency > 1) {
      let server: CodexAppServer | undefined;
      try {
        await mkdir(this.#options.codexHome, { recursive: true });
        const codexHome = await realpath(resolve(this.#options.codexHome));
        if (codexHome === join(homedir(), '.codex'))
          throw new Error('The local Codex login cannot be reused for CI reviews');
        const env = {
          ...runtimeEnvironment({ ...process.env, ...this.#options.env }),
          CODEX_HOME: codexHome,
          HOME: codexHome,
        };
        const executable = this.#options.executable ?? 'codex';
        await validateProtocol(executable, codexHome, env, input.signal);
        input.signal?.throwIfAborted();
        server = new CodexAppServer(executable, codexHome, env);
        await server.initialize();
        input.signal?.throwIfAborted();
        return new CodexManagedRuntime(server, this.#options, input);
      } catch (error) {
        await server?.close();
        input.signal?.throwIfAborted();
        this.#options.logger?.info(
          `Sandy managed runtime unavailable before Agent execution; using serial mode (${error instanceof Error ? error.message : 'compatibility gate failed'}).`,
        );
      }
    }
    const controller = new AbortController();
    const reviewSignal = input.signal;
    const preparedWorkspacePath = input.worktreePath;
    const privateWorkspacePaths = input.privateWorkspacePaths ?? [];
    const pending = new Set<Promise<unknown>>();
    return {
      mode: 'serial',
      maxConcurrency: 1,
      runAgent: (input) => {
        controller.signal.throwIfAborted();
        const task = (async () => {
          const toolHome = await mkdtemp(join(tmpdir(), 'sandy-serial-agent-'));
          try {
            const temporaryDirectory = join(toolHome, 'tmp');
            await mkdir(temporaryDirectory);
            const ownPath = await realpath(input.worktreePath);
            const protectedWorkspacePaths = await Promise.all(
              [preparedWorkspacePath, ...privateWorkspacePaths].map((path) => realpath(path)),
            );
            const serial = new CodexExecRunner({
              ...this.#options,
              toolHome,
              temporaryDirectory,
              protectedPaths: [
                ...(this.#options.protectedPaths ?? []),
                ...protectedWorkspacePaths.filter((path) => path !== ownPath),
              ],
              env: { ...this.#options.env, OPENSRC_HOME: join(toolHome, 'opensrc') },
            });
            return await serial.runAgent({
              ...input,
              signal: AbortSignal.any([
                controller.signal,
                ...(input.signal ? [input.signal] : []),
                ...(reviewSignal ? [reviewSignal] : []),
              ]),
            });
          } finally {
            await rm(toolHome, { recursive: true, force: true });
          }
        })();
        pending.add(task);
        void task.finally(() => pending.delete(task)).catch(() => {});
        return task;
      },
      close: async () => {
        controller.abort(new Error('Review runtime closed'));
        await Promise.allSettled(pending);
      },
    };
  }
}

const exec = promisify(execFile);
async function validateProtocol(
  executable: string,
  codexHome: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  const options = {
    cwd: codexHome,
    env,
    timeout: 10_000,
    maxBuffer: 4096,
    ...(signal ? { signal } : {}),
  };
  const version = await exec(executable, ['--version'], options);
  if (version.stdout.trim() !== 'codex-cli 0.162.0')
    throw new Error('Managed reviews require Codex 0.162.0');
  const directory = await mkdtemp(join(codexHome, 'protocol-'));
  try {
    await exec(
      executable,
      ['app-server', 'generate-json-schema', '--experimental', '--out', directory],
      options,
    );
    for (const [name, fields] of Object.entries({
      ThreadStartParams: ['permissions', 'runtimeWorkspaceRoots', 'config', 'ephemeral'],
      TurnStartParams: ['threadId', 'input', 'effort', 'permissions'],
      ThreadTokenUsageUpdatedNotification: ['threadId', 'turnId', 'tokenUsage'],
      TurnCompletedNotification: ['threadId', 'turn'],
      TurnInterruptParams: ['threadId', 'turnId'],
      ThreadBackgroundTerminalsCleanParams: ['threadId'],
      GetAccountParams: ['refreshToken'],
    })) {
      const schema = protocolObject(
        JSON.parse(await readFile(join(directory, 'v2', `${name}.json`), 'utf8')),
        'schema',
      );
      const properties = protocolObject(schema.properties, 'schema properties');
      if (fields.some((field) => !(field in properties)))
        throw new Error(`Codex protocol lacks required ${name} fields`);
      if (name === 'ThreadTokenUsageUpdatedNotification') {
        const definitions = protocolObject(schema.definitions, 'usage definitions');
        const breakdown = protocolObject(definitions.TokenUsageBreakdown, 'usage breakdown schema');
        const usageFields = protocolObject(breakdown.properties, 'usage breakdown fields');
        if (
          ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens'].some(
            (field) => !(field in usageFields),
          )
        )
          throw new Error('Codex protocol lacks required token counters');
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
