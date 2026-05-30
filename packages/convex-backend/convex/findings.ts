import { v } from 'convex/values';
import { mutation, query } from './_generated/server.js';
import { confidence, crossRepoReference, findingAnchor, severity } from './validators.js';

/** Record a single Finding produced by an Agent during a Review. */
export const recordFinding = mutation({
  args: {
    reviewJobId: v.id('reviewJobs'),
    pullRequestId: v.id('pullRequests'),
    agentKey: v.string(),
    severity,
    confidence,
    anchor: findingAnchor,
    crossRepoReferences: v.optional(v.array(crossRepoReference)),
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

/** Attach the GitHub inline comment id after a persisted Finding is posted. */
export const markPosted = mutation({
  args: {
    findingId: v.id('findings'),
    githubCommentId: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { findingId, githubCommentId }) => {
    await ctx.db.patch(findingId, { githubCommentId });
    return null;
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
