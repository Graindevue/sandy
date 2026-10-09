import type { ApiSurfaceManifestBuildResult, ApiSurfaceRepoInput } from '@sandy/shared-types';
import { aggregateManifest } from './aggregator.js';
import { type LoadExtractorsOptions, loadExtractors } from './extractor-registry.js';

export interface BuildManifestOptions extends LoadExtractorsOptions {
  now?: () => number;
}

export async function buildManifest(
  productId: string,
  repoShas: readonly ApiSurfaceRepoInput[],
  options: BuildManifestOptions = {},
): Promise<ApiSurfaceManifestBuildResult> {
  if (repoShas.length === 0) {
    throw new Error('buildManifest requires at least one Repo');
  }

  const extractors = await loadExtractors(options);
  return await aggregateManifest({
    productId,
    repos: repoShas.map(normalizeRepoInput),
    extractors,
    builtAt: options.now?.() ?? Date.now(),
  });
}

export { loadExtractors } from './extractor-registry.js';
export { createRepoFileSnapshot, type RepoFileSnapshot } from './fs-utils.js';

function normalizeRepoInput(repo: ApiSurfaceRepoInput): ApiSurfaceRepoInput {
  const fullName = repo.fullName || `${repo.owner}/${repo.name}`;
  const [owner, name] = fullName.split('/');
  return {
    owner: repo.owner || owner || '',
    name: repo.name || name || '',
    fullName,
    defaultBranch: repo.defaultBranch,
    worktreePath: repo.worktreePath,
    sha: repo.sha,
  };
}
