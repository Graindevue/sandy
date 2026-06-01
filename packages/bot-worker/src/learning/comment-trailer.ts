const FINDING_TRAILER_RE = /<!--\s*bot:finding=([^\s>]+)(?:\s+archetype=[^\s>]+)?\s*-->/g;

export function* findingIdsFromCommentTrailer(body: string): Iterable<string> {
  for (const match of body.matchAll(FINDING_TRAILER_RE)) {
    const findingId = match[1];
    if (findingId !== undefined) {
      yield findingId;
    }
  }
}
