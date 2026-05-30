import type {
  CrossRepoReference,
  CrossRepoSearchRationale,
  Finding,
  SiblingShas,
} from '@sandy/shared-types';

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

export interface PosterLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface PostReviewResultInput {
  target: PullRequestTarget;
  agentKey: string;
  findings: PersistedFinding[];
  /** Sibling Repo SHAs pinned when the ReviewJob started. */
  siblingShas: SiblingShas;
  summary?: string;
  crossRepoSearch: CrossRepoSearchRationale;
}

export interface PostScopeDeclinedInput {
  target: PullRequestTarget;
  changedLines: number;
  maxChangedLines: number;
}

const defaultLogger: PosterLogger = console;

export class PullRequestPoster {
  readonly #github: GitHubReviewPoster;
  readonly #logger: PosterLogger;

  constructor(github: GitHubReviewPoster, options: { logger?: PosterLogger } = {}) {
    this.#github = github;
    this.#logger = options.logger ?? defaultLogger;
  }

  async postReviewResult(input: PostReviewResultInput): Promise<PostedFinding[]> {
    const posted: PostedFinding[] = [];

    for (const persisted of input.findings) {
      try {
        const comment = await this.#github.createPullRequestReviewComment(
          buildReviewCommentInput(input.target, persisted, input.siblingShas),
        );
        posted.push({ findingId: persisted.id, commentId: comment.id });
      } catch (error) {
        this.#logger.warn(`failed to post review comment for finding ${persisted.id}`, error);
      }
    }

    await this.#github.createIssueComment({
      owner: input.target.owner,
      repo: input.target.repo,
      issueNumber: input.target.pullNumber,
      body: buildSummaryBody(
        input.agentKey,
        input.findings.length,
        input.summary,
        input.crossRepoSearch,
      ),
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
  siblingShas: SiblingShas,
): ReviewCommentInput {
  const { finding } = persisted;
  const base: ReviewCommentInput = {
    owner: target.owner,
    repo: target.repo,
    pullNumber: target.pullNumber,
    commitId: target.headSha,
    path: finding.anchor.path,
    body: formatFindingBody(persisted, siblingShas),
    line: finding.anchor.lineEnd,
    side: 'RIGHT',
  };

  if (finding.anchor.lineStart !== finding.anchor.lineEnd) {
    base.startLine = finding.anchor.lineStart;
    base.startSide = 'RIGHT';
  }

  return base;
}

export function formatFindingBody(
  { id, finding }: PersistedFinding,
  siblingShas: SiblingShas,
): string {
  const parts = [
    `**${finding.severity} ${finding.category}** (confidence ${finding.confidence}/5)`,
    finding.summary,
    `Evidence:\n${finding.evidence}`,
  ];
  if (finding.suggestedFix !== undefined) {
    parts.push(`Suggested fix:\n${finding.suggestedFix}`);
  }
  if (finding.crossRepoReferences !== undefined && finding.crossRepoReferences.length > 0) {
    parts.push(
      `Cross-repo references:\n${finding.crossRepoReferences
        .map((reference) => `- ${formatCrossRepoReference(reference, siblingShas)}`)
        .join('\n')}`,
    );
  }
  parts.push(`<!-- bot:finding=${id} -->`);
  return parts.join('\n\n');
}

function formatCrossRepoReference(reference: CrossRepoReference, siblingShas: SiblingShas): string {
  const sha = siblingShas[reference.repo];
  if (sha === undefined) {
    return `${reference.repo}/${reference.path}:${reference.line}`;
  }

  const encodedPath = reference.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${reference.repo}/blob/${sha}/${encodedPath}#L${reference.line}`;
}

function buildSummaryBody(
  agentKey: string,
  findingCount: number,
  summary: string | undefined,
  crossRepoSearch: CrossRepoSearchRationale,
): string {
  const parts = [
    buildSummaryHeadline(agentKey, findingCount),
    formatCrossRepoSearch(crossRepoSearch),
  ];
  const trimmedSummary = summary?.trim();
  if (trimmedSummary !== undefined && trimmedSummary.length > 0) {
    parts.push(trimmedSummary);
  }
  return parts.join('\n\n');
}

function buildSummaryHeadline(agentKey: string, findingCount: number): string {
  if (findingCount === 0) {
    return `Sandy ${agentKey} review: no issues found.`;
  }

  const noun = findingCount === 1 ? 'finding' : 'findings';
  return `Sandy ${agentKey} review posted ${findingCount} ${noun}.`;
}

function formatCrossRepoSearch(search: CrossRepoSearchRationale): string {
  const repos =
    search.searchedRepos === undefined || search.searchedRepos.length === 0
      ? ''
      : ` Repos: ${search.searchedRepos.join(', ')}.`;
  return `Cross-repo search: ${search.status} (${search.trigger}) - ${search.rationale}${repos}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
