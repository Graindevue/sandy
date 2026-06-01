import type { ReactionKind } from '@sandy/shared-types';
import { v } from 'convex/values';
import { mutation, query } from './_generated/server.js';
import { clampLimit } from './limits.js';
import { type RecentArchetypeReaction, recentArchetypeReactions } from './reactionEvidence.js';
import { reactionKind } from './validators.js';

const DEFAULT_RECENT_REACTION_LIMIT = 50;
const MAX_RECENT_REACTION_LIMIT = 200;

const mergeStateReactionKind = v.union(
  v.literal('mergedFixed' satisfies ReactionKind),
  v.literal('mergedIgnored' satisfies ReactionKind),
);

export type { RecentArchetypeReaction } from './reactionEvidence.js';

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
    return await recentArchetypeReactions(ctx.db, {
      archetypeId,
      limit: resolvedLimit,
    });
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
