import type { ReactionKind } from '@sandy/shared-types';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel.js';
import { mutation, query } from './_generated/server.js';
import { reactionKind } from './validators.js';

const DEFAULT_RECENT_REACTION_LIMIT = 50;
const MAX_RECENT_REACTION_LIMIT = 200;
const MAX_FINDINGS_PER_ARCHETYPE = 200;

const mergeStateReactionKind = v.union(
  v.literal('mergedFixed' satisfies ReactionKind),
  v.literal('mergedIgnored' satisfies ReactionKind),
);

export type RecentArchetypeReaction = {
  _id: Id<'reactions'>;
  _creationTime: number;
  findingId: Id<'findings'>;
  kind: ReactionKind;
  replyText?: string;
  findingSummary: string;
};

/** Record feedback captured from a Sandy bot comment. */
export const recordReaction = mutation({
  args: {
    findingId: v.id('findings'),
    kind: reactionKind,
    replyText: v.optional(v.string()),
  },
  returns: v.id('reactions'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('reactions', args);
  },
});

/** Recent feedback signals attached to Findings in one Archetype. */
export const recentByArchetype = query({
  args: {
    archetypeId: v.id('archetypes'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { archetypeId, limit }): Promise<RecentArchetypeReaction[]> => {
    const resolvedLimit = clampLimit(
      limit,
      DEFAULT_RECENT_REACTION_LIMIT,
      MAX_RECENT_REACTION_LIMIT,
    );
    const findings = await ctx.db
      .query('findings')
      .withIndex('by_archetype', (q) => q.eq('archetypeId', archetypeId))
      .take(MAX_FINDINGS_PER_ARCHETYPE);

    const reactions: RecentArchetypeReaction[] = [];
    for (const finding of findings) {
      const findingReactions = await ctx.db
        .query('reactions')
        .withIndex('by_finding', (q) => q.eq('findingId', finding._id))
        .take(resolvedLimit);
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

    return reactions
      .sort((left, right) => right._creationTime - left._creationTime)
      .slice(0, resolvedLimit);
  },
});

/** Record the one merge-state signal for a Finding, idempotently for backstops. */
export const recordMergeStateReaction = mutation({
  args: {
    findingId: v.id('findings'),
    kind: mergeStateReactionKind,
  },
  returns: v.boolean(),
  handler: async (ctx, { findingId, kind }) => {
    const existing = ctx.db
      .query('reactions')
      .withIndex('by_finding', (q) => q.eq('findingId', findingId));
    for await (const reaction of existing) {
      if (reaction.kind === 'mergedFixed' || reaction.kind === 'mergedIgnored') {
        return false;
      }
    }

    await ctx.db.insert('reactions', { findingId, kind });
    return true;
  },
});

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), max));
}
