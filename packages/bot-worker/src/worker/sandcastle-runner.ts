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

    const result = await this.#run({
      agent: this.#createAgentProvider(input.agent, this.#env),
      sandbox: await this.#createAppleContainer({
        imageName: this.#imageName,
        containerNamePrefix: SANDY_WORKER_CONTAINER_PREFIX,
        mounts: [
          {
            hostPath: join(homedir(), '.opensrc'),
            sandboxPath: OPEN_SRC_SANDBOX_CACHE,
          },
        ],
        env: this.#env,
      }),
      cwd: input.worktreePath,
      prompt: buildReviewPrompt(input),
      maxIterations: input.agent.maxIterations,
      completionSignal: input.agent.completionSignal,
      branchStrategy: { type: 'head' },
      name: input.agent.key,
    });

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
  return `${input.agent.systemPrompt}

Review PR #${pr.number}: ${pr.title}

Repository: ${pr.owner}/${pr.repo}
PR URL: ${pr.url}
Base ref: ${pr.baseRef}
Head SHA: ${pr.headSha}

You are running inside the checked-out PR worktree. Review the diff and emit exactly one JSON object inside <findings>...</findings>:

<findings>
{
  "summary": "Optional one-paragraph review summary",
  "findings": []
}
</findings>
`;
}
