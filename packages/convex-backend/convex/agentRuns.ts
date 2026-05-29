import { v } from 'convex/values';
import { mutation } from './_generated/server.js';
import { agentRunStatus } from './validators.js';

/** Record the terminal outcome of one Agent execution within a ReviewJob. */
export const record = mutation({
  args: {
    reviewJobId: v.id('reviewJobs'),
    agentKey: v.string(),
    status: agentRunStatus,
    startedAt: v.number(),
    finishedAt: v.number(),
    findingCount: v.number(),
    error: v.optional(v.string()),
  },
  returns: v.id('agentRuns'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('agentRuns', args);
  },
});
