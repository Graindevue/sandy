import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRunUsage } from '@sandy/shared-types';
import { isIgnoredPath } from '../config/ignore.js';
import { type CodexAppServer, protocolObject, runtimeEnvironment } from './codex-app-server.js';
import type { CodexAppServerRunnerOptions } from './codex-app-server-runner.js';
import type { AgentRunResult, RunAgentInput } from './codex-exec-runner.js';
import { AgentRunError } from './review-errors.js';
import type { ReviewAgentRunner, ReviewAgentRuntime } from './review-executor.js';
import { buildReviewPrompt } from './review-prompt.js';

const exec = promisify(execFile);
type ReviewRuntimeInput = Parameters<NonNullable<ReviewAgentRunner['openReview']>>[0];
interface TurnState {
  id?: string;
  stdout: string;
  settled: boolean;
  result: Promise<string>;
  resolve(stdout: string): void;
  reject(error: Error): void;
  interruption?: Promise<void>;
}
interface ThreadState {
  key: string;
  signal: AbortSignal;
  usage?: AgentRunUsage;
  turn?: TurnState;
  tools: number;
  toolDurationMs: number;
}

/** Sandy admits Agents; this object owns one transport and one authentication manager. */
export class CodexManagedRuntime implements ReviewAgentRuntime {
  readonly mode = 'parallel';
  readonly maxConcurrency: number;
  readonly failureSignal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #threads = new Map<string, ThreadState>();
  readonly #tasks = new Set<Promise<AgentRunResult>>();
  #closing: Promise<void> | undefined;

  constructor(
    readonly server: CodexAppServer,
    readonly options: CodexAppServerRunnerOptions,
    readonly review: ReviewRuntimeInput,
  ) {
    this.maxConcurrency = review.maxConcurrency;
    this.failureSignal = server.failure.signal;
    server.onNotification = (method, params) => this.#notification(method, params);
    server.failure.signal.addEventListener(
      'abort',
      () => {
        for (const state of this.#threads.values())
          state.turn?.reject(server.failure.signal.reason);
      },
      { once: true },
    );
  }

  async runAgent(input: RunAgentInput): Promise<AgentRunResult> {
    this.#controller.signal.throwIfAborted();
    this.failureSignal.throwIfAborted();
    if (this.#tasks.size >= this.maxConcurrency)
      return Promise.reject(new Error('Managed Agent concurrency cap exceeded'));
    const task = this.#runAgent(input);
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => {});
    return task;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#controller.abort(new Error('Review runtime closed'));
    this.#closing = (async () => {
      await Promise.allSettled(this.#tasks);
      await this.server.close();
      this.server.onNotification = undefined;
    })();
    return this.#closing;
  }

  async #runAgent(input: RunAgentInput): Promise<AgentRunResult> {
    const signal = AbortSignal.any([
      this.#controller.signal,
      this.failureSignal,
      ...(this.review.signal ? [this.review.signal] : []),
      ...(input.signal ? [input.signal] : []),
    ]);
    signal.throwIfAborted();
    if (input.agent.vendor !== 'codex') throw new Error('Managed reviews require vendor codex');
    const cwd = await realpath(input.worktreePath);
    if (cwd === (await realpath(this.review.worktreePath)))
      throw new Error('Managed Agents require a private workspace');
    const config = await permissionConfig(this.review, this.options, cwd);
    const prompt = `${buildReviewPrompt(input)}\nPR diff:\n${await reviewDiff(input)}`;
    signal.throwIfAborted();
    const response = await this.server.request('thread/start', {
      model: input.agent.model,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      permissions: 'sandy',
      approvalPolicy: 'never',
      ephemeral: true,
      config,
    });
    const thread = protocolObject(response.thread, 'thread');
    const roots = response.runtimeWorkspaceRoots;
    const profile = protocolObject(response.activePermissionProfile, 'permission profile');
    if (
      typeof thread.id !== 'string' ||
      this.#threads.has(thread.id) ||
      response.cwd !== cwd ||
      response.approvalPolicy !== 'never' ||
      profile.id !== 'sandy' ||
      !Array.isArray(roots) ||
      roots.length !== 1 ||
      roots[0] !== cwd
    ) {
      this.server.fail(new Error('Codex did not retain the requested thread isolation'));
      this.failureSignal.throwIfAborted();
    }
    const threadId = String(thread.id);
    const state: ThreadState = { key: input.agent.key, signal, tools: 0, toolDurationMs: 0 };
    this.#threads.set(threadId, state);
    const startedAt = Date.now();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('Codex Agent exceeded its timeout')),
      this.options.agentTimeoutMs ?? 15 * 60 * 1000,
    );
    const turnSignal = AbortSignal.any([signal, timeout.signal]);
    state.signal = turnSignal;
    const heartbeat = setInterval(
      () =>
        this.options.logger?.info(
          `Sandy Agent ${JSON.stringify(state.key)} running after ${Date.now() - startedAt}ms (${state.tools} completed tools).`,
        ),
      30_000,
    );
    try {
      let stdout = await this.#turn(
        threadId,
        state,
        prompt,
        input.agent.model,
        input.agent.effort,
        turnSignal,
      );
      if (!stdout.includes(input.agent.completionSignal)) {
        stdout = await this.#turn(
          threadId,
          state,
          'Finish this review now. Emit exactly one JSON object inside <findings>...</findings>, including crossRepoSearch and findings. Emit an empty findings array if no confirmed issues remain. Do not repeat your investigation.',
          input.agent.model,
          input.agent.effort,
          turnSignal,
        );
        if (!stdout.includes(input.agent.completionSignal))
          throw new Error('Codex did not complete the findings after one continuation');
      }
      turnSignal.throwIfAborted();
      return {
        stdout,
        ...(state.usage ? { usage: state.usage } : {}),
        ...(state.tools > 0
          ? { activity: { toolCount: state.tools, toolDurationMs: state.toolDurationMs } }
          : {}),
      };
    } catch (error) {
      throw new AgentRunError(error instanceof Error ? error.message : String(error), state.usage);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      // A terminal turn can retain yielded background tools; clean them before returning.
      if (!this.failureSignal.aborted) {
        try {
          await this.server.request('thread/backgroundTerminals/clean', { threadId });
        } catch {
          this.server.fail(new Error('Codex could not quiesce Agent tools'));
        }
      }
      this.options.logger?.info(
        `Sandy Agent ${JSON.stringify(state.key)} finished after ${Date.now() - startedAt}ms (${state.tools} completed tools, ${state.toolDurationMs}ms tool activity).`,
      );
      this.#threads.delete(threadId);
    }
  }

  async #turn(
    threadId: string,
    state: ThreadState,
    prompt: string,
    model: string,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    let resolveTurn: (stdout: string) => void = () => {};
    let rejectTurn: (error: Error) => void = () => {};
    const result = new Promise<string>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    // The completion observer exists before turn/start: notifications can precede its response.
    const turn: TurnState = {
      stdout: '',
      settled: false,
      result,
      resolve: (stdout) => {
        turn.settled = true;
        resolveTurn(stdout);
      },
      reject: (error) => {
        turn.settled = true;
        rejectTurn(error);
      },
    };
    void result.catch(() => {});
    state.turn = turn;
    const abort = () =>
      void this.#interrupt(threadId, turn).catch((error) => this.server.fail(error));
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.server.request('turn/start', {
        threadId,
        model,
        ...(effort ? { effort } : {}),
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      const returned = protocolObject(response.turn, 'started turn');
      if (typeof returned.id !== 'string' || (turn.id !== undefined && turn.id !== returned.id))
        throw new Error('Codex turn identity mismatch');
      turn.id = returned.id;
      if (signal.aborted) await this.#interrupt(threadId, turn);
      const stdout = await result;
      signal.throwIfAborted();
      return stdout;
    } catch (error) {
      if (!turn.settled) this.server.fail(new Error('Codex turn could not terminate safely'));
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      await turn.interruption;
    }
  }

  #interrupt(threadId: string, turn: TurnState): Promise<void> {
    if (turn.interruption !== undefined) return turn.interruption;
    if (turn.settled || turn.id === undefined || this.failureSignal.aborted)
      return Promise.resolve();
    turn.interruption = (async () => {
      await this.server.request('turn/interrupt', { threadId, turnId: turn.id });
      const timer = setTimeout(
        () => this.server.fail(new Error('Codex interrupted turn did not quiesce')),
        5000,
      );
      try {
        await turn.result.catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    })();
    return turn.interruption;
  }

  #notification(method: string, params: Record<string, unknown>): void {
    if (typeof params.threadId !== 'string') return;
    const state = this.#threads.get(params.threadId);
    if (state === undefined) return;
    const turn = state.turn;
    if (turn === undefined) return;
    const eventTurnId =
      method === 'turn/completed' || method === 'turn/started'
        ? protocolObject(params.turn, 'turn').id
        : params.turnId;
    if (typeof eventTurnId === 'string') {
      if (turn.id !== undefined && turn.id !== eventTurnId) return;
      turn.id = eventTurnId;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = protocolObject(
        protocolObject(params.tokenUsage, 'usage').total,
        'cumulative usage',
      );
      const input = count(usage.inputTokens);
      const cached = count(usage.cachedInputTokens);
      const created = count(usage.cacheWriteInputTokens);
      if (cached + created > input) throw new Error('Codex cached input exceeds total input');
      state.usage = {
        inputTokens: input - cached - created,
        cacheReadInputTokens: cached,
        cacheCreationInputTokens: created,
        outputTokens: count(usage.outputTokens),
      };
    } else if (method === 'item/completed') {
      const item = protocolObject(params.item, 'completed item');
      if (item.type === 'agentMessage' && typeof item.text === 'string') turn.stdout = item.text;
      if (['commandExecution', 'mcpToolCall', 'webSearch'].includes(String(item.type))) {
        state.tools++;
        if (typeof item.durationMs === 'number' && item.durationMs >= 0)
          state.toolDurationMs += item.durationMs;
      }
    } else if (method === 'turn/completed') {
      const terminal = protocolObject(params.turn, 'terminal turn');
      if (terminal.status === 'completed') {
        for (const value of Array.isArray(terminal.items) ? terminal.items : []) {
          const item = protocolObject(value, 'terminal item');
          if (item.type === 'agentMessage' && typeof item.text === 'string')
            turn.stdout = item.text;
        }
        turn.resolve(turn.stdout);
      } else {
        const error =
          terminal.error === undefined || terminal.error === null
            ? {}
            : protocolObject(terminal.error, 'turn error');
        turn.reject(
          new Error(
            typeof error.message === 'string'
              ? error.message
              : `Codex turn ${String(terminal.status)}`,
          ),
        );
      }
    } else if (method === 'turn/started' && state.signal.aborted) {
      void this.#interrupt(params.threadId, turn).catch((error) => this.server.fail(error));
    }
  }
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid Codex token usage');
  return value;
}

async function permissionConfig(
  review: ReviewRuntimeInput,
  options: CodexAppServerRunnerOptions,
  cwd: string,
): Promise<Record<string, unknown>> {
  const toolHome = await mkdtemp(join(cwd, '.sandy-tools-'));
  const temporary = join(toolHome, 'tmp');
  await mkdir(temporary, { recursive: true });
  const filesystem: Record<string, unknown> = {};
  if (process.platform === 'linux') {
    Object.assign(filesystem, {
      ':minimal': 'read',
      '/opt': 'read',
      glob_scan_max_depth: 2,
      '/proc/*/environ': 'deny',
      '/proc/*/mem': 'deny',
    });
    filesystem[await realpath('/etc/resolv.conf')] = 'read';
    for (const path of [
      cwd,
      ...(review.siblingWorktrees ?? []).map((sibling) => sibling.hostPath),
    ]) {
      const { stdout } = await exec(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: path, env: runtimeEnvironment(process.env), timeout: 10_000 },
      );
      const git = await realpath(stdout.trim());
      if (git === '/') throw new Error('Git metadata requires a scoped path');
      filesystem[git] = 'read';
    }
  } else filesystem[':root'] = 'read';
  if (review.privateWorkspacePaths === undefined)
    throw new Error('Managed Agents require a complete private-workspace inventory');
  const privatePaths = await Promise.all(
    review.privateWorkspacePaths.map((path) => realpath(path)),
  );
  if (!privatePaths.includes(cwd))
    throw new Error('Agent workspace is outside the Review inventory');
  for (const path of privatePaths) {
    if (path !== cwd) filesystem[path] = 'deny';
  }
  filesystem[await realpath(review.worktreePath)] = 'read';
  for (const sibling of review.siblingWorktrees ?? [])
    filesystem[await realpath(sibling.hostPath)] = 'read';
  for (const path of [
    options.codexHome,
    resolve(options.codexHome, '..', 'sandy-sandbox-home'),
    join(homedir(), '.codex'),
    join(homedir(), '.ssh'),
    join(homedir(), '.config', 'gh'),
    ...(options.protectedPaths ?? []),
  ]) {
    filesystem[resolve(path)] = 'deny';
    try {
      filesystem[await realpath(path)] = 'deny';
    } catch {
      /* Missing protected paths remain denied if they are created later. */
    }
  }
  filesystem[':workspace_roots'] = 'write';
  return {
    'permissions.sandy': { filesystem, network: { enabled: true } },
    projects: { [cwd]: { trust_level: 'untrusted' } },
    'shell_environment_policy.inherit': 'core',
    'shell_environment_policy.ignore_default_excludes': false,
    'shell_environment_policy.experimental_use_profile': false,
    'shell_environment_policy.set': {
      HOME: toolHome,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      OPENSRC_HOME: join(toolHome, 'opensrc'),
      TURBO_CACHE_DIR: join(cwd, '.turbo', 'cache'),
      CI: 'true',
      LEFTHOOK: '0',
      HUSKY: '0',
      CONVEX_AGENT_MODE: 'anonymous',
      pnpm_config_verify_deps_before_run: 'false',
      pnpm_config_manage_package_manager_versions: 'false',
      npm_config_manage_package_manager_versions: 'false',
    },
  };
}

async function reviewDiff(input: RunAgentInput): Promise<string> {
  const options = {
    cwd: input.worktreePath,
    env: runtimeEnvironment(process.env),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const revision = `refs/remotes/origin/${input.pullRequest.baseRef}...${input.pullRequest.headSha}`;
  const { stdout: changed } = await exec(
    'git',
    ['diff', '--name-status', '--find-renames', '-z', revision, '--'],
    options,
  );
  const entries = changed.split('\0');
  const paths: string[][] = [];
  for (let index = 0; index < entries.length && entries[index] !== ''; ) {
    const status = entries[index++];
    const before = entries[index++];
    const renamed = status?.startsWith('R') || status?.startsWith('C');
    const after = renamed ? entries[index++] : before;
    if (before === undefined || after === undefined)
      throw new Error('Git emitted incomplete changed paths');
    if (!isIgnoredPath(after, input.botConfig?.ignorePatterns))
      paths.push(renamed ? [before, after] : [after]);
  }
  let diff = '';
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
        ...[...new Set(paths.slice(index, index + 100).flat())].map((path) => `:(literal)${path}`),
      ],
      options,
    );
    diff += stdout;
    if (diff.length > 16 * 1024 * 1024) throw new Error('Review diff exceeds 16MiB');
  }
  return diff;
}
