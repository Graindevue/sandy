import type { ApiSurfaceRepoInput, SiblingShas } from '@sandy/shared-types';
import type { RunnerSiblingWorktree } from './codex-exec-runner.js';

export interface ProductRepoForReview {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface RepoForWorktree {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface WorktreeRequest {
  reviewJobId: string;
  sha: string;
}

export interface ReviewWorktree {
  repo: RepoForWorktree;
  path: string;
  sha: string;
  reviewJobId: string;
}

export interface ReviewCloneManager {
  ensureCloned(repo: RepoForWorktree): Promise<unknown>;
  resolveDefaultBranchSha(repo: RepoForWorktree): Promise<string>;
  createWorktree(repo: RepoForWorktree, request: WorktreeRequest): Promise<ReviewWorktree>;
  removeWorktree(worktree: ReviewWorktree): Promise<void>;
  materializeAgentWorkspace?(seed: ReviewWorktree, agentKey: string): Promise<ReviewWorktree>;
}

export interface ReviewWorkspaceContext {
  job: {
    id: string;
    headSha: string;
  };
  repo: {
    id: string;
    owner: string;
    name: string;
    defaultBranch: string;
  };
  product: {
    slug: string;
    repos: ProductRepoForReview[];
  };
}

export interface ReviewWorkspace {
  prWorktree: ReviewWorktree;
  worktrees: ReviewWorktree[];
  manifestRepos: ApiSurfaceRepoInput[];
  siblingWorktrees: RunnerSiblingWorktree[];
  siblingShas: SiblingShas;
}

export async function materializeReviewWorkspace(
  cloneManager: ReviewCloneManager,
  context: ReviewWorkspaceContext,
): Promise<ReviewWorkspace> {
  const currentRepo = repoForWorktree(context);
  const worktrees: ReviewWorktree[] = [];
  const manifestRepos: ApiSurfaceRepoInput[] = [];
  const siblingWorktrees: RunnerSiblingWorktree[] = [];
  const siblingShas: SiblingShas = {};
  let prWorktree: ReviewWorktree | null = null;

  for (const productRepo of productReposForContext(context)) {
    const repo = repoForProductRepo(productRepo);
    const isPrRepo = sameRepo(repo, currentRepo);
    await cloneManager.ensureCloned(repo);
    const sha = isPrRepo ? context.job.headSha : await cloneManager.resolveDefaultBranchSha(repo);
    const worktree = await cloneManager.createWorktree(repo, {
      reviewJobId: context.job.id,
      sha,
    });
    worktrees.push(worktree);

    if (isPrRepo) {
      prWorktree = worktree;
    } else {
      siblingWorktrees.push({
        repo: productRepo.fullName,
        sha,
        hostPath: worktree.path,
      });
      siblingShas[productRepo.fullName] = sha;
    }

    manifestRepos.push({
      owner: productRepo.owner,
      name: productRepo.name,
      fullName: productRepo.fullName,
      defaultBranch: productRepo.defaultBranch,
      worktreePath: worktree.path,
      sha,
    });
  }

  if (prWorktree === null) {
    throw new Error(
      `Product ${context.product.slug} does not include reviewed Repo ${currentRepo.owner}/${currentRepo.name}`,
    );
  }

  return { prWorktree, worktrees, manifestRepos, siblingWorktrees, siblingShas };
}

function productReposForContext(context: ReviewWorkspaceContext): ProductRepoForReview[] {
  if (context.product.repos.length > 0) {
    return context.product.repos;
  }
  return [
    {
      id: context.repo.id,
      owner: context.repo.owner,
      name: context.repo.name,
      fullName: `${context.repo.owner}/${context.repo.name}`,
      defaultBranch: context.repo.defaultBranch,
    },
  ];
}

function repoForProductRepo(repo: ProductRepoForReview): RepoForWorktree {
  return { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch };
}

function repoForWorktree(context: ReviewWorkspaceContext): RepoForWorktree {
  return {
    owner: context.repo.owner,
    name: context.repo.name,
    defaultBranch: context.repo.defaultBranch,
  };
}

function sameRepo(left: RepoForWorktree, right: RepoForWorktree): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}
