import type { ReactionKind } from '@sandy/shared-types';
import type { RepoRef } from '../webhook/events.js';

export type CapturedReactionKind = Extract<ReactionKind, '👍' | '👎'>;
export type ReactionCaptureCommentKind = 'pull_request_review_comment' | 'issue_comment';

export interface ReactionTarget {
  findingId: string;
  githubCommentId?: number;
}

export interface ReactionCaptureComment {
  id: number;
  body: string;
}

export interface CommentReaction {
  content: string;
}

export interface ReactionCaptureGitHub {
  listPullRequestReviewComments(input: {
    repo: RepoRef;
    pullNumber: number;
  }): Promise<ReactionCaptureComment[]>;
  listIssueComments(input: {
    repo: RepoRef;
    issueNumber: number;
  }): Promise<ReactionCaptureComment[]>;
  listCommentReactions(input: {
    repo: RepoRef;
    commentId: number;
    commentKind?: ReactionCaptureCommentKind;
  }): Promise<CommentReaction[]>;
}

export interface ReactionCaptureStore {
  listReactionTargetsForPr(pullRequestId: string): Promise<ReactionTarget[]>;
  recordReaction(input: { findingId: string; kind: CapturedReactionKind }): Promise<void>;
}

export interface CapturePrCloseReactionsInput {
  repo: RepoRef;
  pullNumber: number;
  pullRequestId: string;
  store: ReactionCaptureStore;
  github: ReactionCaptureGitHub;
}

export interface CapturePrCloseReactionsResult {
  recorded: number;
}

const FINDING_TRAILER_RE = /<!--\s*bot:finding=([^\s>]+)(?:\s+archetype=[^\s>]+)?\s*-->/g;

export async function capturePrCloseReactions(
  input: CapturePrCloseReactionsInput,
): Promise<CapturePrCloseReactionsResult> {
  const targets = await input.store.listReactionTargetsForPr(input.pullRequestId);
  if (targets.length === 0) {
    return { recorded: 0 };
  }

  const knownFindingIds = new Set(targets.map((target) => target.findingId));
  const targetsByCommentId = new Map<number, Set<string>>();
  const kindByCommentId = new Map<number, ReactionCaptureCommentKind>();

  for (const target of targets) {
    if (target.githubCommentId !== undefined) {
      addCommentTarget(targetsByCommentId, target.githubCommentId, target.findingId);
    }
  }

  const [reviewComments, issueComments] = await Promise.all([
    input.github.listPullRequestReviewComments({
      repo: input.repo,
      pullNumber: input.pullNumber,
    }),
    input.github.listIssueComments({
      repo: input.repo,
      issueNumber: input.pullNumber,
    }),
  ]);

  addCommentFallbacks(
    reviewComments,
    'pull_request_review_comment',
    knownFindingIds,
    targetsByCommentId,
    kindByCommentId,
  );
  addCommentFallbacks(
    issueComments,
    'issue_comment',
    knownFindingIds,
    targetsByCommentId,
    kindByCommentId,
  );

  let recorded = 0;
  for (const [commentId, findingIds] of targetsByCommentId.entries()) {
    const commentKind = kindByCommentId.get(commentId);
    const reactions = await input.github.listCommentReactions(
      commentKind === undefined
        ? { repo: input.repo, commentId }
        : { repo: input.repo, commentId, commentKind },
    );
    for (const reaction of reactions) {
      const kind = reactionKindForGitHubContent(reaction.content);
      if (kind === undefined) {
        continue;
      }
      for (const findingId of findingIds) {
        await input.store.recordReaction({ findingId, kind });
        recorded += 1;
      }
    }
  }

  return { recorded };
}

function addCommentFallbacks(
  comments: readonly ReactionCaptureComment[],
  commentKind: ReactionCaptureCommentKind,
  knownFindingIds: ReadonlySet<string>,
  targetsByCommentId: Map<number, Set<string>>,
  kindByCommentId: Map<number, ReactionCaptureCommentKind>,
): void {
  for (const comment of comments) {
    if (targetsByCommentId.has(comment.id)) {
      kindByCommentId.set(comment.id, commentKind);
    }
    for (const findingId of parseFindingIdsFromTrailer(comment.body)) {
      if (!knownFindingIds.has(findingId)) {
        continue;
      }
      addCommentTarget(targetsByCommentId, comment.id, findingId);
      kindByCommentId.set(comment.id, commentKind);
    }
  }
}

function addCommentTarget(
  targetsByCommentId: Map<number, Set<string>>,
  commentId: number,
  findingId: string,
): void {
  const findingIds = targetsByCommentId.get(commentId);
  if (findingIds !== undefined) {
    findingIds.add(findingId);
    return;
  }
  targetsByCommentId.set(commentId, new Set([findingId]));
}

function parseFindingIdsFromTrailer(body: string): string[] {
  return [...body.matchAll(FINDING_TRAILER_RE)].map((match) => match[1]).filter(isDefined);
}

function reactionKindForGitHubContent(content: string): CapturedReactionKind | undefined {
  switch (content) {
    case '+1':
      return '👍';
    case '-1':
      return '👎';
    default:
      return undefined;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
