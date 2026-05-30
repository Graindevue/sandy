import type { CrossRepoReference, Finding, SiblingShas } from '@sandy/shared-types';
import { describe, expect, it, vi } from 'vitest';
import type {
  GitHubReviewPoster,
  IssueCommentInput,
  PersistedFinding,
  PullRequestTarget,
  ReviewCommentInput,
} from './poster.js';
import { formatFindingBody, PullRequestPoster } from './poster.js';

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

const target: PullRequestTarget = {
  owner: 'acme',
  repo: 'widget',
  pullNumber: 12,
  headSha: 'abc123',
};

const noFindingsSummary = 'Confidence score: 0/5\n\nSandy review: no findings posted.';
const oneFindingSummary = 'Confidence score: 3/5\n\nSandy review posted 1 finding.';
const twoFindingsSummary = 'Confidence score: 3/5\n\nSandy review posted 2 findings.';
const consumerReference: CrossRepoReference = {
  repo: 'acme/consumer',
  path: 'src/orders.ts',
  line: 31,
};
const consumerSiblingShas: SiblingShas = { 'acme/consumer': 'consumer-main-sha' };
const consumerPermalink =
  'https://github.com/acme/consumer/blob/consumer-main-sha/src/orders.ts#L31';

describe('PullRequestPoster', () => {
  it('posts inline comments with the load-bearing finding trailer', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    const posted = await poster.postReviewResult({
      target,
      siblingShas: {},
      summary: 'Confidence score: 2/5\n\nSandy review posted 1 finding.',
      findings: [persistedFinding()],
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
    expect(github.issueComments[0]?.body).toContain('Confidence score: 2/5');
    expect(github.issueComments[0]?.body).toContain('Sandy review posted 1 finding.');
  });

  it('posts a clean no-issues summary when there are no findings', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    const posted = await poster.postReviewResult({
      target,
      siblingShas: {},
      summary: noFindingsSummary,
      findings: [],
    });

    expect(posted).toEqual([]);
    expect(github.reviewComments).toEqual([]);
    expect(github.issueComments).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        issueNumber: 12,
        body: noFindingsSummary,
      },
    ]);
  });

  it('continues posting findings and summary when one inline comment fails', async () => {
    const github = new FakeGitHubReviewPoster({ failReviewCommentIndexes: [0] });
    const logger = { warn: vi.fn() };
    const poster = new PullRequestPoster(github, { logger });

    const posted = await poster.postReviewResult({
      target,
      siblingShas: {},
      summary: twoFindingsSummary,
      findings: [
        persistedFinding(),
        persistedFinding(
          {
            anchor: { ...baseFinding.anchor, lineStart: 30, lineEnd: 30 },
            summary: 'The write path skips validation.',
          },
          'finding-2',
        ),
      ],
    });

    expect(posted).toEqual([
      { findingId: 'finding-2', commentId: 101 },
      { findingId: 'finding-1', commentId: 102 },
    ]);
    expect(github.reviewComments).toHaveLength(1);
    expect(github.reviewComments[0]?.body).toContain('The write path skips validation.');
    expect(github.issueComments[0]?.body).toContain('Sandy review posted 2 findings.');
    expect(github.issueComments[0]?.body).toContain('Findings folded into the summary');
    expect(github.issueComments[0]?.body).toContain('<!-- bot:finding=finding-1 -->');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('finding finding-1'),
      expect.any(Error),
    );
  });

  it('renders cross-repo references as pinned GitHub permalinks', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    await poster.postReviewResult({
      target,
      siblingShas: consumerSiblingShas,
      summary: oneFindingSummary,
      findings: [persistedFinding({ crossRepoReferences: [consumerReference] })],
    });

    expect(github.reviewComments[0]?.body).toContain(consumerPermalink);
    expect(github.reviewComments[0]?.owner).toBe('acme');
    expect(github.reviewComments[0]?.repo).toBe('widget');
  });

  it('routes cross-repo findings through the reviewed PR anchor only', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    await poster.postReviewResult({
      target,
      siblingShas: consumerSiblingShas,
      summary: oneFindingSummary,
      findings: [
        persistedFinding({
          anchor: {
            repo: 'acme/widget',
            path: 'src/api.ts',
            lineStart: 41,
            lineEnd: 41,
          },
          crossRepoReferences: [consumerReference],
        }),
      ],
    });

    expect(github.reviewComments).toEqual([
      expect.objectContaining({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 12,
        commitId: 'abc123',
        path: 'src/api.ts',
        line: 41,
      }),
    ]);
    expect(github.reviewComments[0]?.body).toContain(consumerPermalink);
    expect(github.issueComments).toEqual([
      expect.objectContaining({
        owner: 'acme',
        repo: 'widget',
        issueNumber: 12,
      }),
    ]);
  });

  it('caps rendered cross-repo references and summarizes overflow by repo', () => {
    const references = Array.from({ length: 12 }, (_, index) => ({
      repo: index === 11 ? 'acme/mobile' : 'acme/consumer',
      path: `src/orders-${index + 1}.ts`,
      line: index + 1,
    }));

    const body = formatFindingBody(
      {
        id: 'finding-1',
        finding: {
          ...baseFinding,
          crossRepoReferences: references,
        },
      },
      {
        'acme/consumer': 'consumer-main-sha',
        'acme/mobile': 'mobile-main-sha',
      },
    );

    expect(body.match(/https:\/\/github\.com/g)).toHaveLength(10);
    expect(body).toContain('- + 1 more in `acme/consumer`');
    expect(body).toContain('- + 1 more in `acme/mobile`');
  });

  it('folds findings without a reviewed-repo anchor into the summary comment', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    const posted = await poster.postReviewResult({
      target,
      siblingShas: consumerSiblingShas,
      summary: oneFindingSummary,
      findings: [
        persistedFinding({
          anchor: {
            repo: 'acme/consumer',
            path: 'src/orders.ts',
            lineStart: 31,
            lineEnd: 31,
          },
          crossRepoReferences: [consumerReference],
        }),
      ],
    });

    expect(posted).toEqual([{ findingId: 'finding-1', commentId: 101 }]);
    expect(github.reviewComments).toEqual([]);
    expect(github.issueComments[0]?.body).toContain('Findings folded into the summary');
    expect(github.issueComments[0]?.body).toContain('<!-- bot:finding=finding-1 -->');
    expect(github.issueComments[0]?.body).toContain(consumerPermalink);
  });

  it('posts a scope-decline summary for oversized diffs', async () => {
    const github = new FakeGitHubReviewPoster();
    const poster = new PullRequestPoster(github);

    await poster.postScopeDeclined({
      target,
      changedLines: 5001,
      maxChangedLines: 5000,
    });

    expect(github.reviewComments).toEqual([]);
    expect(github.issueComments[0]?.body).toContain('request a smaller scope');
    expect(github.issueComments[0]?.body).toContain('5,001 changed lines');
  });
});

function persistedFinding(overrides: Partial<Finding> = {}, id = 'finding-1'): PersistedFinding {
  return { id, finding: { ...baseFinding, ...overrides } };
}

class FakeGitHubReviewPoster implements GitHubReviewPoster {
  reviewComments: ReviewCommentInput[] = [];
  issueComments: IssueCommentInput[] = [];
  readonly failReviewCommentIndexes: Set<number>;
  #reviewCommentAttempts = 0;
  #nextCommentId = 101;

  constructor(options: { failReviewCommentIndexes?: number[] } = {}) {
    this.failReviewCommentIndexes = new Set(options.failReviewCommentIndexes ?? []);
  }

  async createPullRequestReviewComment(input: ReviewCommentInput): Promise<{ id: number }> {
    const index = this.#reviewCommentAttempts;
    this.#reviewCommentAttempts += 1;
    if (this.failReviewCommentIndexes.has(index)) {
      throw new Error('line is not reviewable');
    }
    this.reviewComments.push(input);
    return { id: this.#nextCommentId++ };
  }

  async createIssueComment(input: IssueCommentInput): Promise<{ id: number }> {
    this.issueComments.push(input);
    return { id: this.#nextCommentId++ };
  }
}
