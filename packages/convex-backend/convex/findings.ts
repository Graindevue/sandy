import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { severity } from './validators';

/** Record a single Finding produced by an Agent during a Review. */
export const recordFinding = mutation({
  args: {
    reviewJobId: v.id('reviewJobs'),
    pullRequestId: v.id('pullRequests'),
    agentKey: v.string(),
    severity,
    confidence: v.number(),
    repo: v.string(),
    path: v.string(),
    lineStart: v.number(),
    lineEnd: v.number(),
    summary: v.string(),
    evidence: v.string(),
    suggestedFix: v.optional(v.string()),
    category: v.string(),
  },
  returns: v.id('findings'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('findings', args);
  },
});

/** All Findings recorded for a PR, newest first. */
export const listForPr = query({
  args: { pullRequestId: v.id('pullRequests') },
  handler: async (ctx, { pullRequestId }) => {
    return await ctx.db
      .query('findings')
      .withIndex('by_pull_request', (q) => q.eq('pullRequestId', pullRequestId))
      .order('desc')
      .collect();
  },
});
