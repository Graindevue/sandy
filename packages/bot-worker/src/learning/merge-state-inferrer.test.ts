import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../webhook/events.js';
import {
  inferPrMergeStateSignals,
  type MergeStateCommit,
  type MergeStateCommitFile,
  type MergeStateGitHub,
  type MergeStateStore,
  type MergeStateTarget,
  rollupMergeStateSignals,
} from './merge-state-inferrer.js';

const REPO = { owner: 'acme', name: 'widget' } satisfies RepoRef;

const TARGET = {
  findingId: 'finding-1',
  githubCommentId: 101,
  anchor: {
    repo: 'acme/widget',
    path: 'src/cache.ts',
    lineStart: 20,
    lineEnd: 20,
  },
} satisfies MergeStateTarget;

describe('inferPrMergeStateSignals', () => {
  it('records mergedFixed when a post-comment commit touches the commented range', async () => {
    const store = new FakeMergeStateStore({ targetsByPr: new Map([['pr-1', [TARGET]]]) });
    const github = new FakeMergeStateGitHub({
      comments: [
        { id: 101, body: 'Finding', kind: 'pull_request_review_comment', createdAt: 1000 },
      ],
      commits: [
        { sha: 'before-comment', committedAt: 500 },
        { sha: 'after-comment', committedAt: 2000 },
      ],
      filesByCommit: new Map([
        [
          'after-comment',
          [
            {
              filename: 'src/cache.ts',
              patch: '@@ -19,5 +19,5 @@\n context\n-old cache key\n+new cache key\n context',
            },
          ],
        ],
      ]),
    });

    const result = await inferPrMergeStateSignals({
      repo: REPO,
      pullNumber: 12,
      pullRequestId: 'pr-1',
      store,
      github,
    });

    expect(result).toEqual({ recorded: 1 });
    expect(store.recorded).toEqual([{ findingId: 'finding-1', kind: 'mergedFixed' }]);
    expect(github.fileRequests).toEqual(['after-comment']);
  });

  it('records mergedIgnored when post-comment commits leave the commented range untouched', async () => {
    const store = new FakeMergeStateStore({ targetsByPr: new Map([['pr-1', [TARGET]]]) });
    const github = new FakeMergeStateGitHub({
      comments: [
        { id: 101, body: 'Finding', kind: 'pull_request_review_comment', createdAt: 1000 },
      ],
      commits: [{ sha: 'after-comment', committedAt: 2000 }],
      filesByCommit: new Map([
        [
          'after-comment',
          [
            {
              filename: 'src/cache.ts',
              patch: '@@ -40,3 +40,3 @@\n context\n-old helper\n+new helper',
            },
          ],
        ],
      ]),
    });

    const result = await inferPrMergeStateSignals({
      repo: REPO,
      pullNumber: 12,
      pullRequestId: 'pr-1',
      store,
      github,
    });

    expect(result).toEqual({ recorded: 1 });
    expect(store.recorded).toEqual([{ findingId: 'finding-1', kind: 'mergedIgnored' }]);
  });
});

describe('rollupMergeStateSignals', () => {
  it('records merge-state signals for merged PRs missed by the close-time pass', async () => {
    const store = new FakeMergeStateStore({
      backfillPullRequests: [{ pullRequestId: 'pr-1', repo: REPO, pullNumber: 12 }],
      targetsByPr: new Map([['pr-1', [TARGET]]]),
    });
    const github = new FakeMergeStateGitHub({
      comments: [
        { id: 101, body: 'Finding', kind: 'pull_request_review_comment', createdAt: 1000 },
      ],
      commits: [{ sha: 'after-comment', committedAt: 2000 }],
      filesByCommit: new Map([
        [
          'after-comment',
          [
            {
              filename: 'src/cache.ts',
              patch: '@@ -19,5 +19,5 @@\n context\n-old cache key\n+new cache key\n context',
            },
          ],
        ],
      ]),
    });

    const result = await rollupMergeStateSignals({
      store,
      github,
      limit: 10,
      now: () => 1234,
    });

    expect(result).toEqual({ checked: 1, recorded: 1 });
    expect(store.recorded).toEqual([{ findingId: 'finding-1', kind: 'mergedFixed' }]);
    expect(store.rolledUp).toEqual([{ pullRequestId: 'pr-1', rolledUpAt: 1234 }]);
  });
});

class FakeMergeStateStore implements MergeStateStore {
  readonly backfillPullRequests: Array<{
    pullRequestId: string;
    repo: RepoRef;
    pullNumber: number;
  }>;
  readonly recorded: Array<{ findingId: string; kind: 'mergedFixed' | 'mergedIgnored' }> = [];
  readonly rolledUp: Array<{ pullRequestId: string; rolledUpAt: number }> = [];
  readonly targetsByPr: Map<string, MergeStateTarget[]>;

  constructor(options: {
    backfillPullRequests?: Array<{ pullRequestId: string; repo: RepoRef; pullNumber: number }>;
    targetsByPr?: Map<string, MergeStateTarget[]>;
  }) {
    this.backfillPullRequests = options.backfillPullRequests ?? [];
    this.targetsByPr = options.targetsByPr ?? new Map();
  }

  async listMergeStateTargetsForPr(pullRequestId: string): Promise<MergeStateTarget[]> {
    return this.targetsByPr.get(pullRequestId) ?? [];
  }

  async recordMergeStateReaction(input: {
    findingId: string;
    kind: 'mergedFixed' | 'mergedIgnored';
  }): Promise<boolean> {
    this.recorded.push(input);
    return true;
  }

  async listMergedPullRequestsForMergeStateBackfill(limit: number): Promise<
    Array<{
      pullRequestId: string;
      repo: RepoRef;
      pullNumber: number;
    }>
  > {
    return this.backfillPullRequests.slice(0, limit);
  }

  async markMergeStateSignalsRolledUp(input: {
    pullRequestId: string;
    rolledUpAt: number;
  }): Promise<void> {
    this.rolledUp.push(input);
  }
}

class FakeMergeStateGitHub implements MergeStateGitHub {
  readonly comments: Awaited<ReturnType<MergeStateGitHub['listReactionCaptureComments']>>;
  readonly commits: MergeStateCommit[];
  readonly filesByCommit: Map<string, MergeStateCommitFile[]>;
  readonly fileRequests: string[] = [];

  constructor(options: {
    comments?: Awaited<ReturnType<MergeStateGitHub['listReactionCaptureComments']>>;
    commits?: MergeStateCommit[];
    filesByCommit?: Map<string, MergeStateCommitFile[]>;
  }) {
    this.comments = options.comments ?? [];
    this.commits = options.commits ?? [];
    this.filesByCommit = options.filesByCommit ?? new Map();
  }

  async listReactionCaptureComments(): Promise<
    Awaited<ReturnType<MergeStateGitHub['listReactionCaptureComments']>>
  > {
    return this.comments;
  }

  async listPullRequestCommits(): Promise<MergeStateCommit[]> {
    return this.commits;
  }

  async listCommitFiles(input: { commitSha: string }): Promise<MergeStateCommitFile[]> {
    this.fileRequests.push(input.commitSha);
    return this.filesByCommit.get(input.commitSha) ?? [];
  }
}
