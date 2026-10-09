import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRunUsage } from '@sandy/shared-types';
import { type CodexAppServer, protocolObject, runtimeEnvironment } from './codex-app-server.js';
import type { CodexAppServerRunnerOptions } from './codex-app-server-runner.js';
import type { AgentRunResult, RunAgentInput } from './codex-exec-runner.js';
import { readReviewDiff } from './review-diff.js';
import { AgentRunError, codexTurnFailure } from './review-errors.js';
import type { ReviewAgentRunner, ReviewAgentRuntime } from './review-executor.js';
import { buildReviewPrompt } from './review-prompt.js';
import { minimalSandboxDenials } from './sandbox-denials.js';

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
  toolDurationMs: number | undefined;
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
  #refresh: Promise<void> | undefined;
  #admitted = false;

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
    if (this.#refresh !== undefined) await this.#refresh;
    this.#controller.signal.throwIfAborted();
    this.#admitted = true;
    if (this.#tasks.size >= this.maxConcurrency)
      return Promise.reject(new Error('Managed Agent concurrency cap exceeded'));
    const task = this.#runAgent(input);
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => {});
    return task;
  }

  async refreshAuthentication(): Promise<void> {
    this.#controller.signal.throwIfAborted();
    this.failureSignal.throwIfAborted();
    if (this.#admitted) throw new Error('Authentication refresh must occur before Agent admission');
    this.#refresh ??= (async () => {
      try {
        // Native OAuth has no request timeout in this pin. Bound the complete operation and
        // terminate its owner on timeout so it cannot write credentials after shutdown.
        await this.server.request('account/read', { refreshToken: true }, 60_000);
      } catch (error) {
        this.server.fail(error instanceof Error ? error : new Error('Native auth refresh failed'));
        throw error;
      }
    })();
    await this.#refresh;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#controller.abort(new Error('Review runtime closed'));
    this.#closing = (async () => {
      if (this.#refresh !== undefined) await Promise.allSettled([this.#refresh]);
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
    const prompt = `${buildReviewPrompt(input)}\nPR diff:\n${await readReviewDiff(input, runtimeEnvironment(process.env))}`;
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
    let stdout = '';
    let failure: Error | undefined;
    try {
      stdout = await this.#turn(
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
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
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
        `Sandy Agent ${JSON.stringify(state.key)} finished after ${Date.now() - startedAt}ms (${state.tools} completed tools, ${state.tools > 0 && state.toolDurationMs !== undefined ? `${state.toolDurationMs}ms` : 'unknown duration'} tool activity).`,
      );
      this.#threads.delete(threadId);
    }
    // Cleanup can emit final usage and tool events even after the turn terminal.
    if (failure !== undefined)
      throw new AgentRunError(
        failure.message,
        state.usage,
        failure instanceof AgentRunError ? failure.failure : undefined,
      );
    return {
      stdout,
      ...(state.usage ? { usage: state.usage } : {}),
      ...(state.tools > 0
        ? {
            activity: {
              toolCount: state.tools,
              ...(state.toolDurationMs !== undefined
                ? { toolDurationMs: state.toolDurationMs }
                : {}),
            },
          }
        : {}),
    };
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
      const cached = count(usage.cachedInputTokens ?? 0);
      const created = count(usage.cacheWriteInputTokens ?? 0);
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
        if (
          state.toolDurationMs !== undefined &&
          typeof item.durationMs === 'number' &&
          Number.isFinite(item.durationMs) &&
          item.durationMs >= 0
        )
          state.toolDurationMs += item.durationMs;
        else state.toolDurationMs = undefined;
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
          new AgentRunError(
            typeof error.message === 'string'
              ? error.message
              : `Codex turn ${String(terminal.status)}`,
            undefined,
            codexTurnFailure(error.codexErrorInfo, error.message),
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
  const denied = Object.entries(filesystem)
    .filter(([, access]) => access === 'deny')
    .map(([path]) => path);
  const grants = [
    cwd,
    ...Object.entries(filesystem)
      .filter(([path, access]) => isAbsolute(path) && (access === 'read' || access === 'write'))
      .map(([path]) => path),
  ];
  const retained = new Set(await minimalSandboxDenials(denied, grants));
  for (const path of denied) if (!retained.has(path)) delete filesystem[path];
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
