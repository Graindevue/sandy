import type { Finding } from '@sandy/shared-types';

export interface PullRequestTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  /** The PR head SHA GitHub requires when creating inline review comments. */
  headSha: string;
}

export interface PersistedFinding {
  id: string;
  finding: Finding;
}

export interface PostedFinding {
  findingId: string;
  commentId: number;
}

export interface ReviewCommentInput {
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

export interface IssueCommentInput {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

export interface GitHubReviewPoster {
  createPullRequestReviewComment(input: ReviewCommentInput): Promise<{ id: number }>;
  createIssueComment(input: IssueCommentInput): Promise<{ id: number }>;
}

export interface PostReviewResultInput {
  target: PullRequestTarget;
  agentKey: string;
  findings: PersistedFinding[];
  summary?: string;
}

export interface PostScopeDeclinedInput {
  target: PullRequestTarget;
  changedLines: number;
  maxChangedLines: number;
}

export class PullRequestPoster {
  readonly #github: GitHubReviewPoster;

  constructor(github: GitHubReviewPoster) {
    this.#github = github;
  }

  async postReviewResult(input: PostReviewResultInput): Promise<PostedFinding[]> {
    const posted: PostedFinding[] = [];

    for (const persisted of input.findings) {
      const comment = await this.#github.createPullRequestReviewComment(
        buildReviewCommentInput(input.target, persisted),
      );
      posted.push({ findingId: persisted.id, commentId: comment.id });
    }

    await this.#github.createIssueComment({
      owner: input.target.owner,
      repo: input.target.repo,
      issueNumber: input.target.pullNumber,
      body: buildSummaryBody(input.agentKey, input.findings.length, input.summary),
    });

    return posted;
  }

  async postScopeDeclined(input: PostScopeDeclinedInput): Promise<void> {
    await this.#github.createIssueComment({
      owner: input.target.owner,
      repo: input.target.repo,
      issueNumber: input.target.pullNumber,
      body:
        `Sandy review skipped: this PR has ${formatCount(input.changedLines)} changed lines, ` +
        `which is over the ${formatCount(input.maxChangedLines)} line Phase 1 limit. ` +
        'Please request a smaller scope for review.',
    });
  }
}

function buildReviewCommentInput(
  target: PullRequestTarget,
  persisted: PersistedFinding,
): ReviewCommentInput {
  const { finding } = persisted;
  const base: ReviewCommentInput = {
    owner: target.owner,
    repo: target.repo,
    pullNumber: target.pullNumber,
    commitId: target.headSha,
    path: finding.location.path,
    body: formatFindingBody(persisted),
    line: finding.location.lineEnd,
    side: 'RIGHT',
  };

  if (finding.location.lineStart !== finding.location.lineEnd) {
    base.startLine = finding.location.lineStart;
    base.startSide = 'RIGHT';
  }

  return base;
}

export function formatFindingBody({ id, finding }: PersistedFinding): string {
  const parts = [
    `**${finding.severity} ${finding.category}** (confidence ${finding.confidence}/5)`,
    finding.summary,
    `Evidence:\n${finding.evidence}`,
  ];
  if (finding.suggestedFix !== undefined) {
    parts.push(`Suggested fix:\n${finding.suggestedFix}`);
  }
  parts.push(`<!-- bot:finding=${id} -->`);
  return parts.join('\n\n');
}

function buildSummaryBody(
  agentKey: string,
  findingCount: number,
  summary: string | undefined,
): string {
  const headline = buildSummaryHeadline(agentKey, findingCount);
  const trimmedSummary = summary?.trim();
  if (trimmedSummary === undefined || trimmedSummary.length === 0) {
    return headline;
  }
  return `${headline}\n\n${trimmedSummary}`;
}

function buildSummaryHeadline(agentKey: string, findingCount: number): string {
  if (findingCount === 0) {
    return `Sandy ${agentKey} review: no issues found.`;
  }

  const noun = findingCount === 1 ? 'finding' : 'findings';
  return `Sandy ${agentKey} review posted ${findingCount} ${noun}.`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
