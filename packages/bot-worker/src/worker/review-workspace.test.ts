import { describe, expect, it } from 'vitest';
import {
  materializeReviewWorkspace,
  type RepoForWorktree,
  type ReviewCloneManager,
  type ReviewWorkspaceContext,
  type ReviewWorktree,
  type WorktreeRequest,
} from './review-workspace.js';

describe('materializeReviewWorkspace', () => {
  it('pins sibling SHAs with the sibling worktrees they came from', async () => {
    const cloneManager = new FakeCloneManager();
    cloneManager.defaultBranchShas.set('acme/desktop', 'desktop-main-sha');

    const workspace = await materializeReviewWorkspace(cloneManager, reviewContext());

    expect(workspace.siblingWorktrees).toEqual([
      {
        repo: 'acme/desktop',
        sha: 'desktop-main-sha',
        hostPath: '/tmp/worktree/acme/desktop/job-1',
      },
    ]);
    expect(workspace.siblingShas).toEqual({ 'acme/desktop': 'desktop-main-sha' });
  });
});

function reviewContext(): ReviewWorkspaceContext {
  return {
    job: { id: 'job-1', headSha: 'widget-head-sha' },
    repo: {
      id: 'repo-1',
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    },
    product: {
      slug: 'acme',
      repos: [
        {
          id: 'repo-1',
          owner: 'acme',
          name: 'widget',
          fullName: 'acme/widget',
          defaultBranch: 'main',
        },
        {
          id: 'repo-2',
          owner: 'acme',
          name: 'desktop',
          fullName: 'acme/desktop',
          defaultBranch: 'main',
        },
      ],
    },
  };
}

class FakeCloneManager implements ReviewCloneManager {
  defaultBranchShas = new Map<string, string>();
  ensured: RepoForWorktree[] = [];
  removed: ReviewWorktree[] = [];

  async ensureCloned(repo: RepoForWorktree): Promise<void> {
    this.ensured.push(repo);
  }

  async resolveDefaultBranchSha(repo: RepoForWorktree): Promise<string> {
    return this.defaultBranchShas.get(`${repo.owner}/${repo.name}`) ?? 'default-sha';
  }

  async createWorktree(repo: RepoForWorktree, request: WorktreeRequest): Promise<ReviewWorktree> {
    return {
      repo,
      reviewJobId: request.reviewJobId,
      sha: request.sha,
      path: `/tmp/worktree/${repo.owner}/${repo.name}/${request.reviewJobId}`,
    };
  }

  async removeWorktree(worktree: ReviewWorktree): Promise<void> {
    this.removed.push(worktree);
  }
}
