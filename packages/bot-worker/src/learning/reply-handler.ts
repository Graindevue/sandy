import type { RepoRef } from '../webhook/events.js';
import { findingIdsFromTrailer } from './comment-trailer.js';
import type {
  ReactionCaptureGitHub,
  ReactionCaptureStore,
  ReactionTarget,
} from './reaction-capture.js';

export interface ReplyCaptureComment {
  id: number;
  body: string;
  inReplyToId?: number;
}

export interface CaptureCommentReplyInput {
  repo: RepoRef;
  pullNumber: number;
  pullRequestId: string;
  comment: ReplyCaptureComment;
  store: ReactionCaptureStore;
  github: Pick<ReactionCaptureGitHub, 'listReactionCaptureComments'>;
}

export interface CaptureCommentReplyResult {
  recorded: number;
}

export async function captureCommentReply(
  input: CaptureCommentReplyInput,
): Promise<CaptureCommentReplyResult> {
  const parentCommentId = input.comment.inReplyToId;
  if (parentCommentId === undefined) {
    return { recorded: 0 };
  }

  const targets = await input.store.listReactionTargetsForPr(input.pullRequestId);
  if (targets.length === 0) {
    return { recorded: 0 };
  }

  const findingIds = await findingIdsForParentComment({
    repo: input.repo,
    pullNumber: input.pullNumber,
    parentCommentId,
    targets,
    github: input.github,
  });

  let recorded = 0;
  for (const findingId of findingIds) {
    await input.store.recordReaction({
      findingId,
      kind: 'reply',
      replyText: input.comment.body,
    });
    recorded += 1;
  }

  return { recorded };
}

async function findingIdsForParentComment(input: {
  repo: RepoRef;
  pullNumber: number;
  parentCommentId: number;
  targets: readonly ReactionTarget[];
  github: Pick<ReactionCaptureGitHub, 'listReactionCaptureComments'>;
}): Promise<Set<string>> {
  const byStoredCommentId = findingIdsForStoredCommentId(input.targets, input.parentCommentId);
  if (byStoredCommentId.size > 0) {
    return byStoredCommentId;
  }

  const comments = await input.github.listReactionCaptureComments({
    repo: input.repo,
    pullNumber: input.pullNumber,
  });
  const parent = comments.find((comment) => comment.id === input.parentCommentId);
  if (parent === undefined) {
    return new Set();
  }

  const knownFindingIds = new Set(input.targets.map((target) => target.findingId));
  const fromTrailer = new Set<string>();
  for (const findingId of findingIdsFromTrailer(parent.body)) {
    if (knownFindingIds.has(findingId)) {
      fromTrailer.add(findingId);
    }
  }
  return fromTrailer;
}

function findingIdsForStoredCommentId(
  targets: readonly ReactionTarget[],
  parentCommentId: number,
): Set<string> {
  const findingIds = new Set<string>();
  for (const target of targets) {
    if (target.githubCommentId === parentCommentId) {
      findingIds.add(target.findingId);
    }
  }
  return findingIds;
}
