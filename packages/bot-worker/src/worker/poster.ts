import type { CrossRepoReference, Finding, SiblingShas } from '@sandy/shared-types';
import type { PostableFinding } from './review-findings.js';

export interface PullRequestTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  /** The PR head SHA GitHub requires when creating inline review comments. */
  headSha: string;
}

export interface PostedFinding {
  findingId: string;
  commentId: number;
}

export interface PostedSummaryComment {
  commentId: number;
  url: string;
}

export interface PostedReviewResult {
  postedFindings: PostedFinding[];
  summaryComment: PostedSummaryComment;
}

interface ReviewCommentInputBase {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  path: string;
  body: string;
}

type ReviewCommentLineRange = { line: number; side: 'RIGHT' } & (
  | { startLine?: never; startSide?: never }
  | { startLine: number; startSide: 'RIGHT' }
);

export type ReviewCommentInput = ReviewCommentInputBase & ReviewCommentLineRange;

export interface IssueCommentInput {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

export interface CreatedIssueComment {
  id: number;
  url?: string;
}

export interface GitHubReviewPoster {
  createPullRequestReviewComment(input: ReviewCommentInput): Promise<{ id: number }>;
  createIssueComment(input: IssueCommentInput): Promise<CreatedIssueComment>;
}

export interface PosterLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface PostReviewResultInput {
  target: PullRequestTarget;
  findings: readonly PostableFinding[];
  /** Sibling Repo SHAs pinned when the ReviewJob started. */
  siblingShas: SiblingShas;
  summary: string;
}

export interface PostScopeDeclinedInput {
  target: PullRequestTarget;
  changedLines: number;
  maxChangedLines: number;
}

const defaultLogger: PosterLogger = console;
const CROSS_REPO_REFERENCE_RENDER_LIMIT = 10;

export class PullRequestPoster {
  readonly #github: GitHubReviewPoster;
  readonly #logger: PosterLogger;

  constructor(github: GitHubReviewPoster, options: { logger?: PosterLogger } = {}) {
    this.#github = github;
    this.#logger = options.logger ?? defaultLogger;
  }

  async postReviewResult(input: PostReviewResultInput): Promise<PostedReviewResult> {
    const inlinePosted: PostedFinding[] = [];
    const summaryOnly: PostableFinding[] = [];

    for (const persisted of input.findings) {
      if (!isReviewedRepoAnchor(input.target, persisted.finding.anchor.repo)) {
        summaryOnly.push(persisted);
        continue;
      }

      try {
        const comment = await this.#github.createPullRequestReviewComment(
          buildReviewCommentInput(input.target, persisted, input.siblingShas),
        );
        inlinePosted.push({ findingId: persisted.id, commentId: comment.id });
      } catch (error) {
        this.#logger.warn(`failed to post review comment for finding ${persisted.id}`, error);
        summaryOnly.push(persisted);
      }
    }

    const summaryComment = await this.#github.createIssueComment({
      owner: input.target.owner,
      repo: input.target.repo,
      issueNumber: input.target.pullNumber,
      body: appendSummaryOnlyFindings(input.summary, summaryOnly, input.siblingShas),
    });

    return {
      postedFindings: [
        ...inlinePosted,
        ...summaryOnly.map((persisted) => ({
          findingId: persisted.id,
          commentId: summaryComment.id,
        })),
      ],
      summaryComment: {
        commentId: summaryComment.id,
        url: summaryComment.url ?? fallbackIssueCommentUrl(input.target, summaryComment.id),
      },
    };
  }

  async postScopeDeclined(input: PostScopeDeclinedInput): Promise<PostedSummaryComment> {
    const comment = await this.#github.createIssueComment({
      owner: input.target.owner,
      repo: input.target.repo,
      issueNumber: input.target.pullNumber,
      body:
        `Sandy review skipped: this PR has ${formatCount(input.changedLines)} changed lines, ` +
        `which is over the ${formatCount(input.maxChangedLines)} line Phase 1 limit. ` +
        'Please request a smaller scope for review.',
    });
    return {
      commentId: comment.id,
      url: comment.url ?? fallbackIssueCommentUrl(input.target, comment.id),
    };
  }
}

function fallbackIssueCommentUrl(target: PullRequestTarget, commentId: number): string {
  return `https://github.com/${target.owner}/${target.repo}/pull/${target.pullNumber}#issuecomment-${commentId}`;
}

function buildReviewCommentInput(
  target: PullRequestTarget,
  persisted: PostableFinding,
  siblingShas: SiblingShas,
): ReviewCommentInput {
  const { finding } = persisted;
  return {
    owner: target.owner,
    repo: target.repo,
    pullNumber: target.pullNumber,
    commitId: target.headSha,
    path: finding.anchor.path,
    body: formatFindingBody(persisted, siblingShas),
    ...reviewCommentLineRange(finding.anchor),
  };
}

function reviewCommentLineRange(anchor: Finding['anchor']): ReviewCommentLineRange {
  if (anchor.lineStart === anchor.lineEnd) {
    return {
      line: anchor.lineEnd,
      side: 'RIGHT',
    };
  }

  return {
    line: anchor.lineEnd,
    side: 'RIGHT',
    startLine: anchor.lineStart,
    startSide: 'RIGHT',
  };
}

function isReviewedRepoAnchor(target: PullRequestTarget, anchorRepo: string): boolean {
  return anchorRepo.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase();
}

function appendSummaryOnlyFindings(
  summary: string,
  findings: readonly PostableFinding[],
  siblingShas: SiblingShas,
): string {
  if (findings.length === 0) {
    return summary;
  }

  return [
    summary,
    `Findings folded into the summary:\n\n${findings
      .map((finding) => formatSummaryOnlyFinding(finding, siblingShas))
      .join('\n\n')}`,
  ].join('\n\n');
}

function formatSummaryOnlyFinding(postable: PostableFinding, siblingShas: SiblingShas): string {
  const { finding } = postable;
  const parts = [
    formatFindingHeading(finding),
    `Anchor: ${formatAnchor(finding.anchor)}`,
    finding.summary,
    `Evidence:\n${finding.evidence}`,
    ...formatFindingDetailSections(postable, siblingShas),
  ];

  return parts.join('\n\n');
}

function formatAnchor(anchor: Finding['anchor']): string {
  const line =
    anchor.lineStart === anchor.lineEnd
      ? `${anchor.lineEnd}`
      : `${anchor.lineStart}-${anchor.lineEnd}`;
  return `${anchor.repo}/${anchor.path}:${line}`;
}

export function formatFindingBody(postable: PostableFinding, siblingShas: SiblingShas): string {
  const { finding } = postable;
  const parts = [
    formatFindingHeading(finding),
    finding.summary,
    `Evidence:\n${finding.evidence}`,
    ...formatFindingDetailSections(postable, siblingShas),
  ];

  return parts.join('\n\n');
}

function formatFindingHeading(finding: Finding): string {
  return `**${finding.severity} ${finding.category}** (confidence ${finding.confidence}/5)`;
}

function formatFindingDetailSections(
  postable: PostableFinding,
  siblingShas: SiblingShas,
): string[] {
  const { id, finding } = postable;
  const parts: string[] = [];

  if (finding.suggestedFix !== undefined) {
    parts.push(`Suggested fix:\n${finding.suggestedFix}`);
  }
  if (finding.crossRepoReferences !== undefined && finding.crossRepoReferences.length > 0) {
    parts.push(formatCrossRepoReferences(finding.crossRepoReferences, siblingShas));
  }
  parts.push(formatCommentTrailer(id, postable.archetypeId));

  return parts;
}

function formatCommentTrailer(id: string, archetypeId: string | undefined): string {
  if (archetypeId === undefined) {
    return `<!-- bot:finding=${id} -->`;
  }
  return `<!-- bot:finding=${id} archetype=${archetypeId} -->`;
}

function formatCrossRepoReferences(
  references: readonly CrossRepoReference[],
  siblingShas: SiblingShas,
): string {
  const visible = references
    .slice(0, CROSS_REPO_REFERENCE_RENDER_LIMIT)
    .map((reference) => `- ${formatCrossRepoReference(reference, siblingShas)}`);
  const overflow = formatReferenceOverflow(references.slice(CROSS_REPO_REFERENCE_RENDER_LIMIT));

  return `Cross-repo references:\n${[...visible, ...overflow].join('\n')}`;
}

function formatReferenceOverflow(references: readonly CrossRepoReference[]): string[] {
  const countsByRepo = new Map<string, number>();
  for (const reference of references) {
    countsByRepo.set(reference.repo, (countsByRepo.get(reference.repo) ?? 0) + 1);
  }

  return [...countsByRepo.entries()].map(([repo, count]) => `- + ${count} more in \`${repo}\``);
}

function formatCrossRepoReference(reference: CrossRepoReference, siblingShas: SiblingShas): string {
  const sha = siblingShas[reference.repo];
  if (sha === undefined) {
    return `${reference.repo}/${reference.path}:${reference.line}`;
  }

  const encodedPath = reference.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${reference.repo}/blob/${sha}/${encodedPath}#L${reference.line}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
