import type { Finding } from '@sandy/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { PullRequestPoster } from './poster.js';

const baseFinding: Finding = {
  severity: 'P1',
  confidence: 4,
  agentKey: 'logic',
  anchor: {
    repo: 'acme/widget',
    path: 'src/cache.ts',
    lineStart: 22,
    lineEnd: 24,
  },
  summary: 'The cache key ignores the tenant id.',
  evidence: 'The lookup only uses userId, so two tenants can collide.',
  suggestedFix: 'Include tenantId in the key.',
  category: 'logic',
};

describe('PullRequestPoster', () => {
  it('posts inline comments with the load-bearing finding trailer', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    const posted = await poster.postReviewResult({
      target: { owner: 'acme', repo: 'widget', pullNumber: 12, headSha: 'abc123' },
      agentKey: 'logic',
      summary: 'One issue found.',
      findings: [{ id: 'finding-1', finding: baseFinding }],
    });

    expect(posted).toEqual([{ findingId: 'finding-1', commentId: 101 }]);
    expect(github.reviewComments).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 12,
        commitId: 'abc123',
        path: 'src/cache.ts',
        body: expect.stringContaining('<!-- bot:finding=finding-1 -->'),
        line: 24,
        side: 'RIGHT',
        startLine: 22,
        startSide: 'RIGHT',
      },
    ]);
    expect(github.reviewComments[0]?.body).toContain('The cache key ignores the tenant id.');
    expect(github.issueComments[0]?.body).toContain('Sandy logic review posted 1 finding.');
  });

  it('posts a clean no-issues summary when there are no findings', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    const posted = await poster.postReviewResult({
      target: { owner: 'acme', repo: 'widget', pullNumber: 12, headSha: 'abc123' },
      agentKey: 'logic',
      summary: 'No correctness issues were found.',
      findings: [],
    });

    expect(posted).toEqual([]);
    expect(github.reviewComments).toEqual([]);
    expect(github.issueComments).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        issueNumber: 12,
        body: 'Sandy logic review: no issues found.\n\nNo correctness issues were found.',
      },
    ]);
  });

  it('continues posting findings and summary when one inline comment fails', async () => {
    const github = new FakeGitHubReviewPoster({ failReviewCommentIndexes: [0] });
    const logger = { warn: vi.fn() };
    const poster = new PullRequestPoster(github, { logger });

    const posted = await poster.postReviewResult({
      target: { owner: 'acme', repo: 'widget', pullNumber: 12, headSha: 'abc123' },
      agentKey: 'logic',
      summary: 'Two issues found.',
      findings: [
        { id: 'finding-1', finding: baseFinding },
        {
          id: 'finding-2',
          finding: {
            ...baseFinding,
            anchor: { ...baseFinding.anchor, lineStart: 30, lineEnd: 30 },
            summary: 'The write path skips validation.',
          },
        },
      ],
    });

    expect(posted).toEqual([{ findingId: 'finding-2', commentId: 101 }]);
    expect(github.reviewComments).toHaveLength(2);
    expect(github.issueComments[0]?.body).toContain('Sandy logic review posted 2 findings.');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('finding finding-1'),
      expect.any(Error),
    );
  });

  it('posts a scope-decline summary for oversized diffs', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    await poster.postScopeDeclined({
      target: { owner: 'acme', repo: 'widget', pullNumber: 12, headSha: 'abc123' },
      changedLines: 5001,
      maxChangedLines: 5000,
    });

    expect(github.reviewComments).toEqual([]);
    expect(github.issueComments[0]?.body).toContain('request a smaller scope');
    expect(github.issueComments[0]?.body).toContain('5,001 changed lines');
  });
});

class FakeGitHubReviewPoster {
  reviewComments: ReviewCommentInput[] = [];
  issueComments: IssueCommentInput[] = [];
  readonly failReviewCommentIndexes: Set<number>;
  #nextCommentId = 101;

  constructor(options: { failReviewCommentIndexes?: number[] } = {}) {
    this.failReviewCommentIndexes = new Set(options.failReviewCommentIndexes ?? []);
  }

  async createPullRequestReviewComment(input: ReviewCommentInput): Promise<{ id: number }> {
    const index = this.reviewComments.length;
    this.reviewComments.push(input);
    if (this.failReviewCommentIndexes.has(index)) {
      throw new Error('line is not reviewable');
    }
    return { id: this.#nextCommentId++ };
  }

  async createIssueComment(input: IssueCommentInput): Promise<{ id: number }> {
    this.issueComments.push(input);
    return { id: this.#nextCommentId++ };
  }
}

interface ReviewCommentInput {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  path: string;
  body: string;
  line: number;
  side: 'RIGHT';
  startLine?: number;
  startSide?: 'RIGHT';
}

interface IssueCommentInput {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}
