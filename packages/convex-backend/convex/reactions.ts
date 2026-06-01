import { v } from 'convex/values';
import { mutation } from './_generated/server.js';
import { reactionKind } from './validators.js';

const mergeStateReactionKind = v.union(v.literal('mergedFixed'), v.literal('mergedIgnored'));

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
