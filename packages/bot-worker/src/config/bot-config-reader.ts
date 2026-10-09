import { createRepoFileSnapshot, type RepoFileSnapshot } from '@sandy/manifest-builder';
import type { ApiSurfaceRepoInput } from '@sandy/shared-types';
import type { ProductConfig, RepoConfig } from './bot-yaml.js';
import { parseIgnoreGitignore } from './ignore.js';
import type { ReviewBotContext } from './review-bot-context.js';

export interface RepoBotConfig {
  repo: RepoConfig;
  rules: string | null;
  productRules: string | null;
  agentsYaml: string | null;
  ignorePatterns: string[];
}

export interface ReviewBotConfig extends ReviewBotContext {
  repos: RepoBotConfig[];
}

export interface BotConfigReaderOptions {
  repoPath: (repo: RepoConfig) => string | Promise<string>;
}

export interface ReadReviewBotConfigOptions {
  reviewRepoPath?: string;
  reviewRepoSha?: string;
  repoSources?: readonly Pick<ApiSurfaceRepoInput, 'fullName' | 'worktreePath' | 'sha'>[];
}

export class BotConfigReader {
  readonly #repoPath: (repo: RepoConfig) => string | Promise<string>;

  constructor(options: BotConfigReaderOptions) {
    this.#repoPath = options.repoPath;
  }

  async readReviewBotConfig(
    product: ProductConfig,
    reviewRepo: RepoConfig,
    options: ReadReviewBotConfigOptions = {},
  ): Promise<ReviewBotConfig> {
    const reviewRepoKey = repoKey(reviewRepo);
    const repos = await Promise.all(
      product.repos.map(async (repo) => {
        const source = options.repoSources?.find(
          (source) => source.fullName.toLowerCase() === repoKey(repo),
        );
        if (options.repoSources !== undefined && source === undefined) {
          throw new Error(`Pinned source is missing for ${repo.fullName}`);
        }
        const root =
          source?.worktreePath ??
          (repoKey(repo) === reviewRepoKey && options.reviewRepoPath !== undefined
            ? options.reviewRepoPath
            : await this.#repoPath(repo));
        const sha =
          source?.sha ?? (repoKey(repo) === reviewRepoKey ? options.reviewRepoSha : undefined);
        return await readRepoBotConfig(repo, root, sha);
      }),
    );
    const reviewedConfig = repos.find((repoConfig) => repoKey(repoConfig.repo) === reviewRepoKey);
    return {
      repoRules: reviewedConfig?.rules ?? null,
      productRules: mergeProductRules(repos),
      ignorePatterns: reviewedConfig?.ignorePatterns ?? [],
      repos,
    };
  }
}

async function readRepoBotConfig(
  repo: RepoConfig,
  root: string,
  sha?: string,
): Promise<RepoBotConfig> {
  const snapshot = await createRepoFileSnapshot(root, sha);
  const [rules, productRules, agentsYaml, ignoreGitignore] = await Promise.all([
    readOptionalBotFile(snapshot, '.bot/rules.md'),
    readOptionalBotFile(snapshot, '.bot/product-rules.md'),
    readOptionalBotFile(snapshot, '.bot/agents.yaml'),
    readOptionalBotFile(snapshot, '.bot/ignore.gitignore'),
  ]);

  return {
    repo,
    rules,
    productRules,
    agentsYaml,
    ignorePatterns: ignoreGitignore === null ? [] : parseIgnoreGitignore(ignoreGitignore),
  };
}

async function readOptionalBotFile(
  snapshot: RepoFileSnapshot,
  path: string,
): Promise<string | null> {
  let contents: string | null;
  try {
    contents = await snapshot.readText(path);
  } catch (error) {
    throw new Error(`could not read ${path}: ${describeError(error)}`);
  }
  if (contents === null) return null;
  const normalized = contents.replace(/\r\n/g, '\n').trim();
  return normalized.length === 0 ? null : normalized;
}

function mergeProductRules(repos: readonly RepoBotConfig[]): string | null {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const repo of repos) {
    if (repo.productRules === null) {
      continue;
    }
    for (const line of repo.productRules.split('\n')) {
      const normalized = line.trim();
      if (normalized.length === 0 || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged.length === 0 ? null : merged.join('\n');
}

function repoKey(repo: Pick<RepoConfig, 'owner' | 'name'>): string {
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
