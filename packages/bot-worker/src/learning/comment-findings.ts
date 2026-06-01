import { findingIdsFromTrailer } from './comment-trailer.js';

export interface FindingCommentTarget {
  findingId: string;
  githubCommentId?: number;
}

export function knownFindingIdsForTargets(targets: readonly FindingCommentTarget[]): Set<string> {
  return new Set(targets.map((target) => target.findingId));
}

export function findingIdsForStoredCommentId(
  targets: readonly FindingCommentTarget[],
  commentId: number,
): Set<string> {
  const findingIds = new Set<string>();
  for (const target of targets) {
    if (target.githubCommentId === commentId) {
      findingIds.add(target.findingId);
    }
  }
  return findingIds;
}

export function findingIdsFromTrailerMatching(
  body: string,
  knownFindingIds: ReadonlySet<string>,
): Set<string> {
  const findingIds = new Set<string>();
  for (const findingId of findingIdsFromTrailer(body)) {
    if (knownFindingIds.has(findingId)) {
      findingIds.add(findingId);
    }
  }
  return findingIds;
}
