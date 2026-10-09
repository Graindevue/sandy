import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
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
        const root =
          repoKey(repo) === reviewRepoKey && options.reviewRepoPath !== undefined
            ? options.reviewRepoPath
            : await this.#repoPath(repo);
        return await readRepoBotConfig(repo, root);
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

async function readRepoBotConfig(repo: RepoConfig, root: string): Promise<RepoBotConfig> {
  const botDir = join(root, '.bot');
  const [rules, productRules, agentsYaml, ignoreGitignore] = await Promise.all([
    readOptionalBotFile(root, join(botDir, 'rules.md')),
    readOptionalBotFile(root, join(botDir, 'product-rules.md')),
    readOptionalBotFile(root, join(botDir, 'agents.yaml')),
    readOptionalBotFile(root, join(botDir, 'ignore.gitignore')),
  ]);

  return {
    repo,
    rules,
    productRules,
    agentsYaml,
    ignorePatterns: ignoreGitignore === null ? [] : parseIgnoreGitignore(ignoreGitignore),
  };
}

async function readOptionalBotFile(root: string, path: string): Promise<string | null> {
  let contents: string;
  try {
    // PR-owned symlinks must not turn host-side context reads into credential
    // reads outside the checkout, before the Agent sandbox can protect them.
    const [repoRoot, resolvedPath] = await Promise.all([realpath(root), realpath(path)]);
    const fromRoot = relative(repoRoot, resolvedPath);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('.bot files must not resolve outside the repository');
    }
    if (!(await stat(resolvedPath)).isFile()) {
      throw new Error('.bot entries must be a regular file');
    }
    contents = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw new Error(`could not read ${path}: ${describeError(error)}`);
  }
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
