import type { ReactionKind } from '@sandy/shared-types';
import type { Id } from './_generated/dataModel.js';
import type { DatabaseReader } from './_generated/server.js';

export const MAX_FINDINGS_PER_ARCHETYPE_FOR_REACTIONS = 200;

export type RecentArchetypeReaction = {
  _id: Id<'reactions'>;
  _creationTime: number;
  findingId: Id<'findings'>;
  kind: ReactionKind;
  replyText?: string;
  findingSummary: string;
};

export async function recentArchetypeReactions(
  db: Pick<DatabaseReader, 'query'>,
  {
    archetypeId,
    limit,
  }: {
    archetypeId: Id<'archetypes'>;
    limit: number;
  },
): Promise<RecentArchetypeReaction[]> {
  const findings = await db
    .query('findings')
    .withIndex('by_archetype', (q) => q.eq('archetypeId', archetypeId))
    .take(MAX_FINDINGS_PER_ARCHETYPE_FOR_REACTIONS);

  const reactions: RecentArchetypeReaction[] = [];
  for (const finding of findings) {
    const findingReactions = await db
      .query('reactions')
      .withIndex('by_finding', (q) => q.eq('findingId', finding._id))
      .take(limit);
    for (const reaction of findingReactions) {
      reactions.push({
        _id: reaction._id,
        _creationTime: reaction._creationTime,
        findingId: reaction.findingId,
        kind: reaction.kind,
        ...(reaction.replyText === undefined ? {} : { replyText: reaction.replyText }),
        findingSummary: finding.summary,
      });
    }
  }

  return reactions.sort((left, right) => right._creationTime - left._creationTime).slice(0, limit);
}
