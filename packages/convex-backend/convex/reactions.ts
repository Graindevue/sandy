import { v } from 'convex/values';
import { mutation } from './_generated/server.js';
import { reactionKind } from './validators.js';

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
