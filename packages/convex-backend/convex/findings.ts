import { v } from 'convex/values';
import type { Id } from './_generated/dataModel.js';
import { mutation, query } from './_generated/server.js';
import { confidence, crossRepoReference, findingAnchor, severity } from './validators.js';

const findingFields = {
  agentKey: v.string(),
  severity,
  confidence,
  anchor: findingAnchor,
  crossRepoReferences: v.optional(v.array(crossRepoReference)),
  summary: v.string(),
  evidence: v.string(),
  suggestedFix: v.optional(v.string()),
  category: v.string(),
};

const findingInput = v.object(findingFields);

/** Record a single Finding produced by an Agent during a Review. */
export const recordFinding = mutation({
  args: {
    reviewJobId: v.id('reviewJobs'),
    pullRequestId: v.id('pullRequests'),
    ...findingFields,
  },
  returns: v.id('findings'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('findings', args);
  },
});

/** Atomically persist synthesized Findings and their ReviewJob confidence score. */
export const recordSynthesizedReview = mutation({
  args: {
    reviewJobId: v.id('reviewJobs'),
    pullRequestId: v.id('pullRequests'),
    confidenceScore: confidence,
    findings: v.array(findingInput),
  },
  returns: v.array(v.id('findings')),
  handler: async (ctx, { reviewJobId, pullRequestId, confidenceScore, findings }) => {
    await ctx.db.patch(reviewJobId, { confidenceScore });

    const findingIds: Array<Id<'findings'>> = [];
    for (const finding of findings) {
      findingIds.push(
        await ctx.db.insert('findings', {
          reviewJobId,
          pullRequestId,
          ...finding,
        }),
      );
    }
    return findingIds;
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
