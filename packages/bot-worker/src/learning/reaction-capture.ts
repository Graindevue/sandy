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
  kind: ReactionCaptureCommentKind;
}

export interface CommentReaction {
  content: string;
}

export interface ListCommentReactionsInput {
  repo: RepoRef;
  commentId: number;
  commentKind?: ReactionCaptureCommentKind;
}

export interface ReactionCaptureGitHub {
  listReactionCaptureComments(input: {
    repo: RepoRef;
    pullNumber: number;
  }): Promise<ReactionCaptureComment[]>;
  listCommentReactions(input: ListCommentReactionsInput): Promise<CommentReaction[]>;
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

  const comments = await input.github.listReactionCaptureComments({
    repo: input.repo,
    pullNumber: input.pullNumber,
  });

  let recorded = 0;
  for (const candidate of reactionCaptureCandidates(targets, comments)) {
    const reactions = await input.github.listCommentReactions(
      commentReactionsInput(input.repo, candidate),
    );
    for (const reaction of reactions) {
      const kind = reactionKindForGitHubContent(reaction.content);
      if (kind === undefined) {
        continue;
      }
      for (const findingId of candidate.findingIds) {
        await input.store.recordReaction({ findingId, kind });
        recorded += 1;
      }
    }
  }

  return { recorded };
}

interface ReactionCaptureCandidate {
  id: number;
  kind?: ReactionCaptureCommentKind;
  findingIds: Set<string>;
}

function reactionCaptureCandidates(
  targets: readonly ReactionTarget[],
  comments: readonly ReactionCaptureComment[],
): ReactionCaptureCandidate[] {
  const knownFindingIds = new Set(targets.map((target) => target.findingId));
  const candidatesByCommentId = new Map<number, ReactionCaptureCandidate>();

  for (const target of targets) {
    if (target.githubCommentId !== undefined) {
      candidateForComment(candidatesByCommentId, target.githubCommentId).findingIds.add(
        target.findingId,
      );
    }
  }

  for (const comment of comments) {
    const storedCandidate = candidatesByCommentId.get(comment.id);
    if (storedCandidate !== undefined) {
      storedCandidate.kind = comment.kind;
    }
    for (const findingId of findingIdsFromTrailer(comment.body)) {
      if (!knownFindingIds.has(findingId)) {
        continue;
      }
      const candidate = candidateForComment(candidatesByCommentId, comment.id);
      candidate.kind = comment.kind;
      candidate.findingIds.add(findingId);
    }
  }

  return [...candidatesByCommentId.values()];
}

function candidateForComment(
  candidatesByCommentId: Map<number, ReactionCaptureCandidate>,
  commentId: number,
): ReactionCaptureCandidate {
  const existing = candidatesByCommentId.get(commentId);
  if (existing !== undefined) {
    return existing;
  }
  const candidate = { id: commentId, findingIds: new Set<string>() };
  candidatesByCommentId.set(commentId, candidate);
  return candidate;
}

function* findingIdsFromTrailer(body: string): Iterable<string> {
  for (const match of body.matchAll(FINDING_TRAILER_RE)) {
    const findingId = match[1];
    if (findingId !== undefined) {
      yield findingId;
    }
  }
}

function commentReactionsInput(
  repo: RepoRef,
  candidate: ReactionCaptureCandidate,
): ListCommentReactionsInput {
  if (candidate.kind === undefined) {
    return { repo, commentId: candidate.id };
  }
  return { repo, commentId: candidate.id, commentKind: candidate.kind };
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
