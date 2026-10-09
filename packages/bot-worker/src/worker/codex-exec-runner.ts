import { execFile, spawn } from 'node:child_process';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import type { AgentDefinition, AgentRunUsage } from '@sandy/shared-types';
import { isIgnoredPath } from '../config/ignore.js';
import type { ReviewBotContext } from '../config/review-bot-context.js';
import {
  type DependencyDownloadCache,
  type DependencyDownloadCacheMetrics,
  dependencyDownloadCacheKey,
  discardMutableStoreState,
  resetDownloadStore,
  snapshotDownloadStore,
  validateDownloadStore,
} from './dependency-download-cache.js';
import {
  type DependencyInstallResult,
  detectDependencyInstall,
  installWithoutHookOnlyPrepare,
  readPackageJson,
} from './dependency-install.js';
import { buildReviewPrompt } from './review-prompt.js';

export interface RunnerPullRequest {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseRef: string;
  title: string;
  url: string;
}

export interface RunnerSiblingWorktree {
  repo: string;
  sha: string;
  hostPath: string;
}

export interface RunAgentInput {
  agent: AgentDefinition;
  worktreePath: string;
  pullRequest: RunnerPullRequest;
  apiSurfaceManifest?: string;
  siblingWorktrees?: readonly RunnerSiblingWorktree[];
  botConfig?: ReviewBotContext;
  dependencyInstall?: DependencyInstallResult;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  stdout: string;
  usage?: AgentRunUsage;
  activity?: { toolCount: number; toolDurationMs?: number };
}

export type ReviewTestMode = 'targeted' | 'suite';

export interface CodexExecRunnerOptions {
  /** Dedicated CI login. Never copied from the operator's local Codex login. */
  codexHome: string;
  /** Agent-owned tool caches; preparation retains the default shared tool home. */
  toolHome?: string;
  /** Scope temporary writes to this directory for an isolated Agent workspace. */
  temporaryDirectory?: string;
  executable?: string;
  env?: Record<string, string>;
  protectedPaths?: readonly string[];
  agentTimeoutMs?: number;
  installTimeoutMs?: number;
  testTimeoutMs?: number;
  /** Full-suite verification is opt-in; targeted mode leaves it to CI. */
  testMode?: ReviewTestMode;
  dependencyDownloadCache?: DependencyDownloadCache;
  /** Stable provider path across Reviews; installation stores remain Review-local. */
  dependencyDownloadCacheDirectory?: string;
  logger?: { info(message: string): void };
}

const exec = promisify(execFile);
// Every Agent using one login belongs to the same serialized refresh stream.
// Actions concurrency also serializes separate runner processes/jobs.
const authStreams = new Map<string, Promise<void>>();

export class CodexExecRunner {
  readonly #options: CodexExecRunnerOptions;
  readonly #toolHome: string;
  readonly #sandboxHome: string;
  readonly #dependencyCacheDirectory: string;
  readonly #logger: { info(message: string): void };

  constructor(options: CodexExecRunnerOptions) {
    if (
      options.codexHome.trim() === '' ||
      resolvePath(options.codexHome) === join(homedir(), '.codex')
    )
      throw new Error(
        'Codex reviews require a dedicated CI CODEX_HOME; the local Codex login cannot be reused',
      );
    this.#options = options;
    this.#logger = options.logger ?? console;
    this.#toolHome =
      options.toolHome === undefined
        ? resolvePath(options.codexHome, '..', 'sandy-tool-home')
        : resolvePath(options.toolHome);
    this.#sandboxHome = resolvePath(options.codexHome, '..', 'sandy-sandbox-home');
    this.#dependencyCacheDirectory = resolvePath(
      options.dependencyDownloadCacheDirectory ??
        resolvePath(options.codexHome, '..', 'sandy-dependency-downloads'),
    );
  }

  async runAgent(input: RunAgentInput): Promise<AgentRunResult> {
    if (input.agent.vendor !== 'codex')
      throw new Error(
        `GitHub Actions reviews require vendor codex; Agent ${input.agent.key} uses ${input.agent.vendor}`,
      );
    input.signal?.throwIfAborted();
    const key = await realpath(resolvePath(this.#options.codexHome));
    if (key === join(homedir(), '.codex'))
      throw new Error('The local Codex login cannot be reused for CI reviews');
    const previous = authStreams.get(key) ?? Promise.resolve();
    let started = false;
    const task = previous.then(() => {
      started = true;
      return this.#runAgent(input);
    });
    const tail = task.then(
      () => {},
      () => {},
    );
    authStreams.set(key, tail);
    tail.then(() => {
      if (authStreams.get(key) === tail) authStreams.delete(key);
    });
    return withAbort(task, input.signal, () => !started);
  }

  async installDependencies(input: {
    worktreePath: string;
    cacheKey?: string;
    signal?: AbortSignal;
  }): Promise<DependencyInstallResult> {
    input.signal?.throwIfAborted();
    let command: string | undefined;
    try {
      const detected = await detectDependencyInstall(input.worktreePath);
      if (detected === null)
        return {
          status: 'skipped',
          reason: 'no package.json or supported package manager in the worktree',
        };
      command = detected.command;
      const startedAt = Date.now();
      this.#logger.info('Sandy dependency install started.');
      let installed: { exitCode: number; output: string };
      let installationDurationMs = 0;
      let cache: DependencyDownloadCacheMetrics | undefined;
      const deadline = startedAt + (this.#options.installTimeoutMs ?? 15 * 60 * 1000);
      const remaining = () => {
        input.signal?.throwIfAborted();
        const budget = deadline - Date.now();
        if (budget <= 0) throw new Error('Dependency preparation exceeded its installation budget');
        return budget;
      };
      const store = resolvePath(
        this.#options.codexHome,
        '..',
        'sandy-dependency-downloads-install',
        detected.packageManager,
      );
      const downloads = detected.packageManager === 'npm' ? join(store, '_cacache') : store;
      const publishedStore = join(this.#dependencyCacheDirectory, detected.packageManager);
      const publishedDownloads =
        detected.packageManager === 'npm' ? join(publishedStore, '_cacache') : publishedStore;
      const service = this.#options.dependencyDownloadCache;
      let key: string | undefined;
      let restored = false;
      let publicationReady = false;
      let installCommand = detected.command;
      try {
        if (service !== undefined) {
          cache = {
            restore: 'unverified',
            restoreMs: 0,
            fetchMs: 0,
            save: 'skipped',
            saveMs: 0,
            coldRetry: false,
          };
          const candidate = await dependencyDownloadCacheKey({
            worktreePath: input.worktreePath,
            ...(input.cacheKey !== undefined ? { repository: input.cacheKey } : {}),
            detected,
          });
          if (candidate !== undefined) {
            let version = { exitCode: 0, output: candidate.version };
            if (detected.packageManager === 'npm') {
              try {
                version = await this.#sandboxCommand(
                  input,
                  'npm --version',
                  Math.min(remaining(), 10_000),
                );
              } catch {
                input.signal?.throwIfAborted();
                version = { exitCode: 1, output: '' };
              }
            }
            if (version.exitCode === 0 && version.output.trim() === candidate.version) {
              key = candidate.key;
              await resetDownloadStore(store);
              await resetDownloadStore(publishedStore);
              await mkdir(publishedDownloads, { recursive: true });
              const restoreStartedAt = Date.now();
              try {
                const restoredKey = await service.restore({
                  key,
                  storePath: publishedDownloads,
                  signal: AbortSignal.any([
                    ...(input.signal ? [input.signal] : []),
                    AbortSignal.timeout(remaining()),
                  ]),
                });
                if (restoredKey !== undefined && restoredKey !== key)
                  throw new Error('Incompatible cache');
                await snapshotDownloadStore(publishedDownloads, downloads, detected.packageManager);
                restored = restoredKey === key;
                cache.restore = restored ? 'hit' : 'miss';
              } catch {
                input.signal?.throwIfAborted();
                cache.restore = 'unavailable';
                await resetDownloadStore(store);
                await mkdir(downloads, { recursive: true });
                await resetDownloadStore(publishedStore);
              }
              cache.restoreMs = Date.now() - restoreStartedAt;
              installCommand =
                detected.packageManager === 'npm'
                  ? `npm_config_cache=${shellQuote(store)} ${detected.command}`
                  : `${detected.command} --store-dir ${shellQuote(store)} --verify-store-integrity=true --side-effects-cache=false --package-import-method=copy`;
              this.#logger.info(
                `Sandy dependency download cache ${cache.restore} after ${cache.restoreMs}ms.`,
              );
            }
          }
          if (key === undefined)
            this.#logger.info(
              'Sandy dependency download cache unverified; retaining ordinary installation.',
            );
        }
        const install = () =>
          installWithoutHookOnlyPrepare(input.worktreePath, () =>
            this.#sandboxCommand(
              key !== undefined ? { ...input, downloadStorePath: store } : input,
              installCommand,
              service === undefined
                ? (this.#options.installTimeoutMs ?? 15 * 60 * 1000)
                : remaining(),
            ),
          );
        if (key !== undefined && detected.packageManager === 'pnpm' && cache !== undefined) {
          const fetchStartedAt = Date.now();
          try {
            const fetched = await this.#sandboxCommand(
              { ...input, downloadStorePath: store },
              `CI=true LEFTHOOK=0 HUSKY=0 ${detected.packageManagerCommand ?? 'pnpm'} fetch --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir ${shellQuote(store)} --verify-store-integrity=true --side-effects-cache=false --package-import-method=copy`,
              remaining(),
            );
            if (fetched.exitCode !== 0) throw new Error('Download-only preparation failed');
            await discardMutableStoreState(downloads, detected.packageManager);
            await snapshotDownloadStore(downloads, publishedDownloads, detected.packageManager);
            publicationReady = true;
          } catch {
            input.signal?.throwIfAborted();
            cache.restore = 'unavailable';
            await resetDownloadStore(store);
          }
          cache.fetchMs = Date.now() - fetchStartedAt;
          this.#logger.info(
            `Sandy dependency download preparation ${publicationReady ? 'completed' : 'unavailable'} after ${cache.fetchMs}ms.`,
          );
        }
        const installationStartedAt = Date.now();
        installed = await install();
        if (installed.exitCode !== 0 && restored && cache !== undefined) {
          cache.coldRetry = true;
          cache.restore = 'discarded';
          this.#logger.info(
            'Sandy dependency download cache discarded; retrying a cold installation.',
          );
          await resetDownloadStore(store);
          await rm(join(input.worktreePath, 'node_modules'), { recursive: true, force: true });
          installed = await install();
        }
        installationDurationMs = Date.now() - installationStartedAt;
        if (
          installed.exitCode === 0 &&
          service !== undefined &&
          key !== undefined &&
          cache !== undefined &&
          (detected.packageManager === 'npm' || publicationReady) &&
          !restored
        ) {
          const saveStartedAt = Date.now();
          try {
            const preparedKey = await dependencyDownloadCacheKey({
              worktreePath: input.worktreePath,
              ...(input.cacheKey !== undefined ? { repository: input.cacheKey } : {}),
              detected,
            });
            if (preparedKey?.key !== key)
              throw new Error('Reviewed install configuration changed during preparation');
            if (detected.packageManager === 'npm') {
              await discardMutableStoreState(downloads, detected.packageManager);
              await snapshotDownloadStore(downloads, publishedDownloads, detected.packageManager);
            }
            await validateDownloadStore(publishedDownloads, detected.packageManager);
            await service.save({
              key,
              storePath: publishedDownloads,
              signal: AbortSignal.any([
                ...(input.signal ? [input.signal] : []),
                AbortSignal.timeout(remaining()),
              ]),
            });
            cache.save = 'saved';
          } catch {
            input.signal?.throwIfAborted();
            cache.save = 'unavailable';
          }
          cache.saveMs = Date.now() - saveStartedAt;
          this.#logger.info(
            `Sandy dependency download cache save ${cache.save} after ${cache.saveMs}ms.`,
          );
        }
      } catch (error) {
        this.#logger.info(`Sandy dependency install failed after ${Date.now() - startedAt}ms.`);
        throw error;
      } finally {
        if (key !== undefined) {
          await rm(store, { recursive: true, force: true });
          await rm(publishedStore, { recursive: true, force: true });
        }
      }
      const durationMs = installationDurationMs;
      const preparationDurationMs = Date.now() - startedAt;
      this.#logger.info(
        `Sandy dependency install ${installed.exitCode === 0 ? 'completed' : 'failed'} after ${durationMs}ms.`,
      );
      if (service !== undefined)
        this.#logger.info(
          `Sandy dependency preparation completed after ${preparationDurationMs}ms.`,
        );
      if (installed.exitCode !== 0)
        return {
          status: 'failed',
          command,
          error: installed.output || `install exited ${installed.exitCode}`,
        };
      if ((this.#options.testMode ?? 'targeted') === 'targeted') {
        this.#logger.info('Sandy project tests deferred to CI; reviewers can run focused tests.');
        return {
          status: 'installed',
          packageManager: detected.packageManager,
          command,
          durationMs,
          ...(service !== undefined ? { preparationDurationMs } : {}),
          ...(cache !== undefined ? { cache } : {}),
          testStatus: 'deferred',
          testResult:
            'Full project test suite deferred to CI. Reviewers may run focused tests to verify concrete findings.',
        };
      }
      let testStatus: 'passed' | 'failed' | 'skipped' = 'skipped';
      let testResult = 'No test script is defined in package.json; test suite skipped.';
      const manifest = JSON.parse(
        (await readPackageJson(input.worktreePath)).bytes.toString('utf8'),
      ) as { scripts?: { test?: unknown } };
      if (typeof manifest.scripts?.test === 'string') {
        const testCommand = `${detected.packageManagerCommand ?? detected.packageManager} test`;
        const testTimeoutMs = this.#options.testTimeoutMs ?? 2 * 60 * 1000;
        const testsStartedAt = Date.now();
        this.#logger.info(`Sandy project tests started (timeout ${testTimeoutMs}ms).`);
        try {
          const tests = await this.#sandboxCommand(input, testCommand, testTimeoutMs);
          testStatus = tests.exitCode === 0 ? 'passed' : 'failed';
          testResult = `${testCommand} exited ${tests.exitCode}.\n${tests.output}`;
        } catch (error) {
          input.signal?.throwIfAborted();
          testStatus = 'failed';
          testResult = `${testCommand} failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
          this.#logger.info(
            `Sandy project tests ${testStatus === 'passed' ? 'completed' : 'failed'} after ${Date.now() - testsStartedAt}ms.`,
          );
        }
      } else {
        this.#logger.info('Sandy project tests skipped: no project test script is defined.');
      }
      return {
        status: 'installed',
        packageManager: detected.packageManager,
        command,
        durationMs,
        ...(service !== undefined ? { preparationDurationMs } : {}),
        ...(cache !== undefined ? { cache } : {}),
        testStatus,
        testResult,
      };
    } catch (error) {
      input.signal?.throwIfAborted();
      return {
        status: 'failed',
        ...(command !== undefined ? { command } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #sandboxCommand(
    input: { worktreePath: string; signal?: AbortSignal; downloadStorePath?: string },
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string }> {
    const sandboxHome = this.#sandboxHome;
    await mkdir(sandboxHome, { recursive: true });
    // Linux skips writable bind roots that do not yet exist.
    await mkdir(this.#toolHome, { recursive: true });
    const args = [
      'sandbox',
      '--permission-profile',
      'sandy',
      '--cd',
      input.worktreePath,
      ...(await this.#permissionConfig(
        input.worktreePath,
        [],
        input.signal,
        input.downloadStorePath ? [input.downloadStorePath] : [],
      )),
      '--',
      '/bin/sh',
      '-c',
      command,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.#options.executable ?? 'codex', args, {
        cwd: input.worktreePath,
        env: {
          ...safeEnvironment({ ...process.env, ...this.#options.env }),
          HOME: this.#toolHome,
          CODEX_HOME: sandboxHome,
          TURBO_CACHE_DIR: join(resolvePath(input.worktreePath), '.turbo', 'cache'),
        },
        stdio: 'pipe',
        detached: true,
      });
      let outputStart = '';
      let outputTail = '';
      let outputLength = 0;
      let failure: unknown;
      let timedOut = false;
      let descendants: number[] = [];
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (reason: unknown) => {
        if (failure !== undefined) return;
        failure = reason;
        void descendantPids(child.pid).then((pids) => {
          descendants = pids;
          killTree(child.pid, descendants, 'SIGTERM');
          killTimer = setTimeout(() => killTree(child.pid, descendants, 'SIGKILL'), 250);
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate(new Error(`command exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => terminate(input.signal?.reason ?? new Error('Review cancelled'));
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      const append = (chunk: string) => {
        outputStart = (outputStart + chunk).slice(0, 2000);
        outputTail = (outputTail + chunk).slice(-4000);
        outputLength += chunk.length;
      };
      child.stdout.setEncoding('utf8').on('data', append);
      child.stderr.setEncoding('utf8').on('data', append);
      child.once('error', (error) => {
        failure = error;
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        input.signal?.removeEventListener('abort', onAbort);
        killTree(child.pid, descendants, 'SIGKILL');
        const output = (
          outputLength <= 4000
            ? outputTail
            : `${outputStart}\n... [output truncated] ...\n${outputTail.slice(-2000)}`
        ).trim();
        if (failure !== undefined)
          reject(
            timedOut && output !== ''
              ? new Error(
                  `${failure instanceof Error ? failure.message : String(failure)}\n${output}`,
                )
              : failure,
          );
        else resolve({ exitCode: code ?? 1, output });
      });
      child.stdin.on('error', () => {});
      child.stdin.end();
    });
  }

  async #runAgent(input: RunAgentInput): Promise<AgentRunResult> {
    input.signal?.throwIfAborted();
    const pr = input.pullRequest;
    await mkdir(this.#toolHome, { recursive: true });
    const gitOptions = {
      cwd: input.worktreePath,
      env: safeEnvironment(process.env),
      maxBuffer: 16 * 1024 * 1024,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };
    const revision = `refs/remotes/origin/${pr.baseRef}...${pr.headSha}`;
    const { stdout: changedPaths } = await exec(
      'git',
      ['diff', '--name-status', '--find-renames', '-z', revision, '--'],
      gitOptions,
    );
    const entries = changedPaths.split('\0');
    const paths: string[][] = [];
    for (let index = 0; index < entries.length && entries[index] !== ''; ) {
      const status = entries[index++];
      const before = entries[index++];
      const renamed = status?.startsWith('R') || status?.startsWith('C');
      const after = renamed ? entries[index++] : before;
      if (before === undefined || after === undefined)
        throw new Error('Git emitted incomplete changed-path metadata');
      if (!isIgnoredPath(after, input.botConfig?.ignorePatterns))
        paths.push(renamed ? [before, after] : [after]);
    }
    let diff = '';
    // Literal pathspecs protect unusual PR filenames and chunks avoid argv limits.
    for (let index = 0; index < paths.length; index += 100) {
      const { stdout } = await exec(
        'git',
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--find-renames',
          revision,
          '--',
          ...[...new Set(paths.slice(index, index + 100).flat())].map(
            (path) => `:(literal)${path}`,
          ),
        ],
        gitOptions,
      );
      diff += stdout;
      if (diff.length > 16 * 1024 * 1024)
        throw new Error('Review diff exceeds 16MiB after ignored paths are excluded');
    }
    let result = await this.#invoke(input, `${buildReviewPrompt(input)}\nPR diff:\n${diff}`);
    if (!result.stdout.includes(input.agent.completionSignal)) {
      if (result.threadId === undefined)
        throw new Error('Codex omitted the review thread id; cannot resume safely');
      const resumed = await this.#invoke(
        input,
        'Finish this review now. Emit exactly one JSON object inside <findings>...</findings>, including crossRepoSearch and findings. Emit an empty findings array if no confirmed issues remain. Do not repeat your investigation.',
        result.threadId,
      );
      result = { ...resumed, usage: addUsage(result.usage, resumed.usage) };
      if (!result.stdout.includes(input.agent.completionSignal))
        throw new Error('Codex did not complete the findings after one resume');
    }
    return {
      stdout: result.stdout,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
  }

  async #invoke(
    input: RunAgentInput,
    prompt: string,
    threadId?: string,
  ): Promise<{ stdout: string; threadId?: string; usage: AgentRunUsage | undefined }> {
    const args = threadId === undefined ? ['exec'] : ['exec', 'resume'];
    args.push(
      '--json',
      '--model',
      input.agent.model,
      '--ignore-user-config',
      '--ignore-rules',
      ...(await this.#permissionConfig(input.worktreePath, input.siblingWorktrees, input.signal)),
    );
    if (input.agent.effort !== undefined)
      args.push('-c', `model_reasoning_effort=${JSON.stringify(input.agent.effort)}`);
    if (threadId !== undefined) args.push(threadId);
    args.push('-');
    const invocation = `Sandy agent ${JSON.stringify(input.agent.key)} ${threadId === undefined ? 'invocation' : 'resume'}`;
    const startedAt = Date.now();
    let completedTools = 0;
    this.#logger.info(`${invocation} started.`);
    try {
      const jsonl = await new Promise<string>((resolve, reject) => {
        const child = spawn(this.#options.executable ?? 'codex', args, {
          cwd: input.worktreePath,
          env: {
            ...safeEnvironment({ ...process.env, ...this.#options.env }),
            HOME: this.#toolHome,
            CODEX_HOME: resolvePath(this.#options.codexHome),
            TURBO_CACHE_DIR: join(resolvePath(input.worktreePath), '.turbo', 'cache'),
          },
          stdio: 'pipe',
          detached: true,
        });
        let aborted: unknown;
        let descendants: number[] = [];
        let killTimer: NodeJS.Timeout | undefined;
        const terminate = (reason: unknown) => {
          if (aborted !== undefined) return;
          aborted = reason;
          void descendantPids(child.pid).then((pids) => {
            descendants = pids;
            killTree(child.pid, descendants, 'SIGTERM');
            killTimer = setTimeout(() => killTree(child.pid, descendants, 'SIGKILL'), 250);
          });
        };
        const onAbort = () => terminate(input.signal?.reason ?? new Error('Review cancelled'));
        const timeoutMs = this.#options.agentTimeoutMs ?? 15 * 60 * 1000;
        const timer = setTimeout(
          () => terminate(new Error(`Codex agent exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        input.signal?.addEventListener('abort', onAbort, { once: true });
        if (input.signal?.aborted) onAbort();
        let output = '';
        let errorOutput = '';
        let progressBuffer = '';
        const heartbeat = setInterval(
          () =>
            this.#logger.info(
              `${invocation} running after ${Date.now() - startedAt}ms (${completedTools} completed tools).`,
            ),
          30_000,
        );
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          output += chunk;
          if (output.length > 64 * 1024 * 1024) {
            terminate(new Error('Codex JSONL output exceeds 64MiB'));
            return;
          }
          const lines = (progressBuffer + chunk).split('\n');
          progressBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (isCompletedToolEvent(line)) completedTools++;
          }
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          errorOutput = (errorOutput + chunk).slice(-4000);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          input.signal?.removeEventListener('abort', onAbort);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          if (isCompletedToolEvent(progressBuffer)) completedTools++;
          input.signal?.removeEventListener('abort', onAbort);
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
            killTree(child.pid, descendants, 'SIGKILL');
          }
          if (aborted !== undefined) reject(aborted);
          else if (code === 0) resolve(output);
          else reject(new Error(`Codex exited with ${code}: ${errorOutput}`));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
      });
      let stdout = '';
      let usage: AgentRunUsage | undefined;
      let startedThreadId: string | undefined;
      for (const line of jsonl.trim().split('\n')) {
        let event: Record<string, unknown>;
        try {
          event = objectValue(JSON.parse(line), 'Codex JSONL event');
        } catch {
          throw new Error('Codex emitted invalid JSONL');
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
          const error =
            typeof event.error === 'object' && event.error !== null
              ? objectValue(event.error, 'Codex error')
              : undefined;
          throw new Error(
            typeof error?.message === 'string'
              ? error.message
              : typeof event.message === 'string'
                ? event.message
                : 'Codex turn failed',
          );
        }
        if (event.type === 'thread.started' && typeof event.thread_id === 'string')
          startedThreadId = event.thread_id;
        if (
          event.type === 'item.completed' &&
          typeof event.item === 'object' &&
          event.item !== null
        ) {
          const item = objectValue(event.item, 'Codex item');
          if (item.type === 'agent_message' && typeof item.text === 'string') stdout = item.text;
        }
        if (event.type === 'turn.completed' && event.usage !== undefined) {
          const counts = objectValue(event.usage, 'Codex usage');
          const inputTokens = tokenCount(counts.input_tokens, 'input_tokens');
          const cachedTokens = tokenCount(counts.cached_input_tokens ?? 0, 'cached_input_tokens');
          if (cachedTokens > inputTokens) throw new Error('Codex cached input exceeds total input');
          usage = addUsage(usage, {
            inputTokens: inputTokens - cachedTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cachedTokens,
            outputTokens: tokenCount(counts.output_tokens, 'output_tokens'),
          });
        }
      }
      this.#logger.info(
        `${invocation} completed after ${Date.now() - startedAt}ms (${completedTools} completed tools).`,
      );
      return {
        stdout,
        usage,
        ...(startedThreadId !== undefined ? { threadId: startedThreadId } : {}),
      };
    } catch (error) {
      this.#logger.info(
        `${invocation} failed after ${Date.now() - startedAt}ms (${completedTools} completed tools).`,
      );
      throw error;
    }
  }

  async #permissionConfig(
    worktreePath: string,
    siblings: readonly RunnerSiblingWorktree[] = [],
    signal?: AbortSignal,
    writablePaths: readonly string[] = [],
  ): Promise<string[]> {
    const denied = [
      ...new Set([
        resolvePath(this.#options.codexHome),
        this.#sandboxHome,
        this.#dependencyCacheDirectory,
        join(homedir(), '.codex'),
        join(homedir(), '.ssh'),
        join(homedir(), '.config', 'gh'),
        ...(this.#options.protectedPaths ?? []).map((path) => resolvePath(path)),
      ]),
    ];
    const filesystem = denied.map((path) => `${JSON.stringify(path)}="deny"`);
    for (const sibling of siblings)
      filesystem.push(`${JSON.stringify(resolvePath(sibling.hostPath))}="read"`);
    filesystem.push(`${JSON.stringify(this.#toolHome)}="write"`);
    for (const path of writablePaths)
      filesystem.push(`${JSON.stringify(resolvePath(path))}="write"`);
    const opensrcHome = this.#options.env?.OPENSRC_HOME ?? process.env.OPENSRC_HOME;
    if (opensrcHome !== undefined)
      filesystem.push(`${JSON.stringify(resolvePath(opensrcHome))}="write"`);
    if (process.platform === 'linux') {
      // A host-root bind exposes unmapped root ownership inside the user
      // namespace. Scoped reads retain a fresh root and cache ancestors owned
      // by this user, which native addons require when materializing images.
      filesystem.push(
        '":minimal"="read"',
        '":workspace_roots"="write"',
        ...(this.#options.temporaryDirectory === undefined
          ? ['":tmpdir"="write"', '":slash_tmp"="write"']
          : []),
        '"/opt"="read"',
      );
      // Linux resolvers can symlink into /run, outside :minimal's /etc mount.
      const resolver = await realpath('/etc/resolv.conf');
      if (!(await stat(resolver)).isFile()) throw new Error('DNS resolver must be a regular file');
      filesystem.push(`${JSON.stringify(resolver)}="read"`);
      const commonDirectories = new Set<string>();
      for (const path of new Set([worktreePath, ...siblings.map((sibling) => sibling.hostPath)])) {
        const { stdout } = await exec(
          'git',
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          {
            cwd: path,
            env: safeEnvironment(process.env),
            maxBuffer: 4096,
            timeout: 10_000,
            ...(signal !== undefined ? { signal } : {}),
          },
        );
        const commonDirectory = await realpath(stdout.trim());
        if (commonDirectory === '/') throw new Error('Git metadata must have a scoped directory');
        commonDirectories.add(commonDirectory);
      }
      for (const path of commonDirectories) filesystem.push(`${JSON.stringify(path)}="read"`);
      // These patterns only match /proc/<pid>/<file>. Unbounded expansion also
      // enters other users' fd/ns/task directories, which makes Linux sandbox
      // construction fail before the reviewed command starts.
      filesystem.push('glob_scan_max_depth=2', '"/proc/*/environ"="deny"', '"/proc/*/mem"="deny"');
    } else if (this.#options.temporaryDirectory !== undefined) {
      filesystem.push('":root"="read"', '":workspace_roots"="write"');
    }
    const shellEnvironment = {
      HOME: this.#toolHome,
      ...(this.#options.temporaryDirectory === undefined
        ? {}
        : {
            TMPDIR: this.#options.temporaryDirectory,
            TMP: this.#options.temporaryDirectory,
            TEMP: this.#options.temporaryDirectory,
          }),
      TURBO_CACHE_DIR: join(resolvePath(worktreePath), '.turbo', 'cache'),
      CI: 'true',
      LEFTHOOK: '0',
      HUSKY: '0',
      CONVEX_AGENT_MODE: 'anonymous',
      pnpm_config_verify_deps_before_run: 'false',
      pnpm_config_manage_package_manager_versions: 'false',
      npm_config_manage_package_manager_versions: 'false',
      ...(opensrcHome !== undefined ? { OPENSRC_HOME: opensrcHome } : {}),
    };
    return [
      '-c',
      'default_permissions="sandy"',
      '-c',
      `permissions.sandy={${process.platform === 'linux' || this.#options.temporaryDirectory !== undefined ? '' : 'extends=":workspace",'}filesystem={${filesystem.join(',')}},network={enabled=true}}`,
      '-c',
      `projects={${JSON.stringify(resolvePath(worktreePath))}={trust_level="untrusted"}}`,
      '-c',
      'approval_policy="never"',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'shell_environment_policy.inherit="core"',
      '-c',
      'shell_environment_policy.ignore_default_excludes=false',
      '-c',
      'shell_environment_policy.experimental_use_profile=false',
      '-c',
      `shell_environment_policy.set={${Object.entries(shellEnvironment)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(',')}}`,
    ];
  }
}

/** Progress is observational; the final parser remains authoritative for outcomes. */
function isCompletedToolEvent(line: string): boolean {
  try {
    const event = objectValue(JSON.parse(line), 'Codex progress event');
    if (event.type !== 'item.completed') return false;
    const item = objectValue(event.item, 'Codex progress item');
    return (
      typeof item.type === 'string' &&
      ['command_execution', 'mcp_tool_call', 'web_search'].includes(item.type)
    );
  } catch {
    return false;
  }
}

function objectValue(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function tokenCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid Codex ${name} usage`);
  return value;
}

function safeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'USER',
    'LOGNAME',
    'SHELL',
    'OPENSRC_HOME',
  ]) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return {
    ...result,
    CI: 'true',
    LEFTHOOK: '0',
    HUSKY: '0',
    CONVEX_AGENT_MODE: 'anonymous',
    pnpm_config_verify_deps_before_run: 'false',
    pnpm_config_manage_package_manager_versions: 'false',
    npm_config_manage_package_manager_versions: 'false',
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function killTree(
  pid: number | undefined,
  descendants: readonly number[],
  signal: NodeJS.Signals,
): void {
  // Codex shell tools can start their own process group. Kill the recorded
  // descendants as well as the CLI group so detached commands cannot survive.
  for (const descendant of descendants) {
    try {
      process.kill(descendant, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  killGroup(pid, signal);
}

async function descendantPids(rootPid: number | undefined): Promise<number[]> {
  if (rootPid === undefined) return [];
  try {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid='], {
      env: safeEnvironment(process.env),
    });
    const descendants = new Set<number>([rootPid]);
    const rows = stdout
      .trim()
      .split('\n')
      .map((row) => row.trim().split(/\s+/).map(Number));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows) {
        if (
          pid !== undefined &&
          parent !== undefined &&
          descendants.has(parent) &&
          !descendants.has(pid)
        ) {
          descendants.add(pid);
          changed = true;
        }
      }
    }
    descendants.delete(rootPid);
    return [...descendants].reverse();
  } catch {
    return [];
  }
}

async function withAbort<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  waiting: () => boolean,
): Promise<T> {
  if (signal === undefined) return task;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        onAbort = () => {
          if (waiting()) reject(signal.reason ?? new Error('Review cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function addUsage(
  first: AgentRunUsage | undefined,
  second: AgentRunUsage | undefined,
): AgentRunUsage | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    cacheCreationInputTokens: first.cacheCreationInputTokens + second.cacheCreationInputTokens,
    cacheReadInputTokens: first.cacheReadInputTokens + second.cacheReadInputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
  };
}
