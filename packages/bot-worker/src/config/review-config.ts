import type { AgentDefinition, ApiSurfaceRepoInput } from '@sandy/shared-types';
import type { RepoForWorktree } from '../worker/review-executor.js';
import type { ProductConfig, RepoConfig } from './bot-yaml.js';
import { applyProductRuntimeOverride } from './loader.js';
import { EMPTY_REVIEW_BOT_CONTEXT, type ReviewBotContext } from './review-bot-context.js';

interface ConfiguredAgentLoader {
  resolveForRepo(
    owner: string,
    name: string,
  ): {
    agents: AgentDefinition[];
  } | null;
}

interface AgentCandidateLoader {
  config: {
    agents: ReadonlyMap<string, AgentDefinition>;
  };
  resolveForRepo(
    owner: string,
    name: string,
  ): {
    product: ProductConfig;
    agents: AgentDefinition[];
  } | null;
}

interface ReviewBotConfigLoader {
  resolveForRepo(
    owner: string,
    name: string,
  ): {
    product: ProductConfig;
    repo: RepoConfig;
  } | null;
}

interface ReviewBotConfigReader {
  readReviewBotConfig(
    product: ProductConfig,
    repo: RepoConfig,
    options?: {
      reviewRepoPath?: string;
      reviewRepoSha?: string;
      repoSources?: readonly Pick<ApiSurfaceRepoInput, 'fullName' | 'worktreePath' | 'sha'>[];
    },
  ): Promise<ReviewBotContext>;
}

export function resolveConfiguredAgent(
  loader: ConfiguredAgentLoader,
  repo: RepoForWorktree,
  agentKey: string,
): AgentDefinition | null {
  const resolved = loader.resolveForRepo(repo.owner, repo.name);
  if (resolved === null) {
    return null;
  }
  return resolved.agents.find((agent) => agent.key === agentKey) ?? null;
}

export function resolveConfiguredAgents(
  loader: AgentCandidateLoader,
  repo: RepoForWorktree,
): AgentDefinition[] {
  const resolved = loader.resolveForRepo(repo.owner, repo.name);
  if (resolved === null) {
    return [];
  }
  if (resolved.product.agentSelectionMode === 'explicit') {
    return resolved.product.agents.map((agentKey) => {
      const agent = loader.config.agents.get(agentKey);
      if (agent === undefined) {
        throw new Error(`configured Agent ${JSON.stringify(agentKey)} is not loaded`);
      }
      return applyProductRuntimeOverride(resolved.product, { ...agent, defaultEnabled: true });
    });
  }
  return [...loader.config.agents.values()].map((agent) =>
    applyProductRuntimeOverride(resolved.product, agent),
  );
}

export async function resolveReviewBotConfig(
  loader: ReviewBotConfigLoader,
  reader: ReviewBotConfigReader,
  repo: RepoForWorktree,
  worktreePath?: string,
  sha?: string,
  repoSources?: readonly Pick<ApiSurfaceRepoInput, 'fullName' | 'worktreePath' | 'sha'>[],
): Promise<ReviewBotContext> {
  const resolved = loader.resolveForRepo(repo.owner, repo.name);
  if (resolved === null) {
    return EMPTY_REVIEW_BOT_CONTEXT;
  }
  const options =
    worktreePath === undefined && repoSources === undefined
      ? undefined
      : {
          ...(worktreePath === undefined ? {} : { reviewRepoPath: worktreePath }),
          ...(sha === undefined ? {} : { reviewRepoSha: sha }),
          ...(repoSources === undefined ? {} : { repoSources }),
        };
  return await reader.readReviewBotConfig(resolved.product, resolved.repo, options);
}
