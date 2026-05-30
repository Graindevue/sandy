import { v } from 'convex/values';
import { mutation } from './_generated/server.js';
import { agentRunStatus, crossRepoSearchRationale } from './validators.js';

/** Record the terminal outcome of one Agent execution within a ReviewJob. */
export const record = mutation({
  args: {
    reviewJobId: v.id('reviewJobs'),
    agentKey: v.string(),
    status: agentRunStatus,
    startedAt: v.number(),
    finishedAt: v.number(),
    findingCount: v.number(),
    crossRepoSearch: v.optional(crossRepoSearchRationale),
    error: v.optional(v.string()),
  },
  returns: v.id('agentRuns'),
  handler: async (ctx, args) => {
    const agentRunId = await ctx.db.insert('agentRuns', args);
    const reviewJob = await ctx.db.get(args.reviewJobId);
    if (reviewJob !== null) {
      await ctx.db.patch(args.reviewJobId, {
        agentRuns: [...reviewJob.agentRuns, agentRunId],
      });
    }
    return agentRunId;
  },
});
