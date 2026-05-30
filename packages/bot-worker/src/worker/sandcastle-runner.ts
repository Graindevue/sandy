import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  claudeCode,
  codex,
  copilot,
  cursor,
  type RunOptions,
  type RunResult,
  run,
  type SandboxProvider,
} from '@ai-hero/sandcastle';
import type { AgentDefinition } from '@sandy/shared-types';

export interface AppleContainerRunnerOptions {
  readonly imageName?: string;
  readonly containerNamePrefix?: string;
  readonly mounts?: readonly {
    hostPath: string;
    sandboxPath: string;
    readonly?: boolean;
  }[];
  readonly env?: Record<string, string>;
}

export interface RunnerPullRequest {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseRef: string;
  title: string;
  url: string;
}

export interface RunLogicAgentInput {
  agent: AgentDefinition;
  worktreePath: string;
  pullRequest: RunnerPullRequest;
  apiSurfaceManifest?: string;
  signal?: AbortSignal;
}

type SandcastleRun = (options: RunOptions) => Promise<Pick<RunResult, 'stdout'>>;
type AppleContainerFactory = (
  options?: AppleContainerRunnerOptions,
) => SandboxProvider | Promise<SandboxProvider>;
type AgentProviderFactory = (agent: AgentDefinition, env: Record<string, string>) => AgentProvider;

export interface SandcastleRunnerOptions {
  /** Apple Container image tag built by `pnpm sandcastle:build-image`. */
  imageName?: string;
  /** Environment exposed to the Agent provider and sandbox. */
  env?: Record<string, string>;
  run?: SandcastleRun;
  createAppleContainer?: AppleContainerFactory;
  createAgentProvider?: AgentProviderFactory;
}

const DEFAULT_AGENT_IMAGE = 'sandy-agent';
const OPEN_SRC_SANDBOX_CACHE = '/home/agent/.opensrc';
const CODEX_AUTH_SANDBOX_PATH = '/home/agent/.codex/auth.json';
const CODEX_AUTH_STAGE_DIR = join(homedir(), '.sandy', 'codex');
const CODEX_AUTH_STAGE_FILE = join(CODEX_AUTH_STAGE_DIR, 'auth.json');
const APPLE_CONTAINER_PROVIDER_PACKAGE = '@sandy/apple-container-provider';
export const SANDY_WORKER_CONTAINER_PREFIX = 'sandy-worker-';

type AppleContainerProviderModule = {
  appleContainer: (options?: AppleContainerRunnerOptions) => SandboxProvider;
};

export class SandcastleRunner {
  readonly #imageName: string;
  readonly #env: Record<string, string>;
  readonly #run: SandcastleRun;
  readonly #createAppleContainer: AppleContainerFactory;
  readonly #createAgentProvider: AgentProviderFactory;

  constructor(options: SandcastleRunnerOptions = {}) {
    this.#imageName = options.imageName ?? DEFAULT_AGENT_IMAGE;
    this.#env = options.env ?? {};
    this.#run = options.run ?? run;
    this.#createAppleContainer = options.createAppleContainer ?? createDefaultAppleContainer;
    this.#createAgentProvider = options.createAgentProvider ?? createAgentProvider;
  }

  async runLogicAgent(input: RunLogicAgentInput): Promise<string> {
    if (input.agent.key !== 'logic') {
      throw new Error(
        `Phase 1 can only run the logic Agent, got ${JSON.stringify(input.agent.key)}`,
      );
    }

    const mounts: { hostPath: string; sandboxPath: string; readonly?: boolean }[] = [
      { hostPath: join(homedir(), '.opensrc'), sandboxPath: OPEN_SRC_SANDBOX_CACHE },
    ];
    // Codex authenticates from the operator's host ChatGPT login. Stage a
    // world-readable copy of the credential (see stageCodexAuth) and mount only
    // that, read-only, into the Agent's CODEX_HOME — HOME is /home/agent in the
    // sandbox, so codex finds it with no extra env, and codex writes its own
    // session under the writable, container-local /home/agent/.codex.
    if (input.agent.vendor === 'codex') {
      mounts.push({
        hostPath: await stageCodexAuth(),
        sandboxPath: CODEX_AUTH_SANDBOX_PATH,
        readonly: true,
      });
    }

    const runOptions: RunOptions = {
      agent: this.#createAgentProvider(input.agent, this.#env),
      sandbox: await this.#createAppleContainer({
        imageName: this.#imageName,
        containerNamePrefix: SANDY_WORKER_CONTAINER_PREFIX,
        mounts,
        env: this.#env,
      }),
      cwd: input.worktreePath,
      prompt: buildReviewPrompt(input),
      maxIterations: input.agent.maxIterations,
      completionSignal: input.agent.completionSignal,
      branchStrategy: { type: 'head' },
      name: input.agent.key,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };

    const result = await this.#run(runOptions);

    return result.stdout;
  }
}

function createAgentProvider(agent: AgentDefinition, env: Record<string, string>): AgentProvider {
  switch (agent.vendor) {
    case 'claude':
      return claudeCode(agent.model, { env });
    case 'codex':
      return codex(agent.model, { env });
    case 'cursor':
      return cursor(agent.model, { env });
    case 'copilot':
      return copilot(agent.model, { env });
  }
}

/**
 * Stage the host's Codex credential for read-only bind-mounting into the Agent
 * sandbox, and return the staged file's path.
 *
 * Apple Container maps a bind-mounted host file to `root:root` inside the VM, so
 * the non-root `agent` user can only read it when it is world-readable (mode
 * 0644). Rather than relax permissions on the operator's real
 * `~/.codex/auth.json` (codex keeps it 0600), we copy it to a Sandy-owned
 * staging file: the copy is 0644 so the container can read it, but it lives in a
 * 0700 directory so other host users still cannot reach it. The operator's real
 * ~/.codex is only ever read, never modified; re-copying on every run picks up a
 * host `codex login` token refresh.
 */
async function stageCodexAuth(): Promise<string> {
  const source = join(homedir(), '.codex', 'auth.json');
  try {
    await mkdir(CODEX_AUTH_STAGE_DIR, { recursive: true });
    await chmod(CODEX_AUTH_STAGE_DIR, 0o700);
    await copyFile(source, CODEX_AUTH_STAGE_FILE);
    await chmod(CODEX_AUTH_STAGE_FILE, 0o644);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Codex Agent requires a host Codex login at ${source}, but staging it failed: ${detail}. Run \`codex login\` on the host.`,
    );
  }
  return CODEX_AUTH_STAGE_FILE;
}

async function createDefaultAppleContainer(
  options?: AppleContainerRunnerOptions,
): Promise<SandboxProvider> {
  const { appleContainer } = (await import(
    APPLE_CONTAINER_PROVIDER_PACKAGE
  )) as AppleContainerProviderModule;
  return appleContainer(options);
}

export function buildReviewPrompt(input: RunLogicAgentInput): string {
  const pr = input.pullRequest;
  const manifestContext =
    input.apiSurfaceManifest === undefined
      ? ''
      : `
API Surface Manifest context:
Use this manifest as a trigger for Cross-Repo Search. It lists public surface and framework versions only; it does not enumerate callers.

${input.apiSurfaceManifest.trim()}
`;
  return `${input.agent.systemPrompt}

Review PR #${pr.number}: ${pr.title}

Repository: ${pr.owner}/${pr.repo}
PR URL: ${pr.url}
Base ref: ${pr.baseRef}
Head SHA: ${pr.headSha}
${manifestContext}

You are running inside the checked-out PR worktree. Review the diff and emit exactly one JSON object inside <findings>...</findings>:

<findings>
{
  "summary": "Optional one-paragraph review summary",
  "findings": []
}
</findings>
`;
}
