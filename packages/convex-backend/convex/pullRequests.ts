import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { pullRequestState } from './validators';

/**
 * Insert or update a PullRequest keyed by (repo, number). On update the existing
 * `reviewActive` flag is preserved; new PRs start with `reviewActive: false` —
 * Sticky Opt-In means a PR is not reviewed until it is explicitly opted in.
 */
export const upsert = mutation({
  args: {
    repoId: v.id('repos'),
    number: v.number(),
    state: pullRequestState,
    draft: v.boolean(),
    headSha: v.string(),
    baseRef: v.string(),
    title: v.string(),
    author: v.string(),
    url: v.string(),
  },
  returns: v.id('pullRequests'),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('pullRequests')
      .withIndex('by_repo_and_number', (q) => q.eq('repoId', args.repoId).eq('number', args.number))
      .unique();
    if (existing !== null) {
      await ctx.db.patch(existing._id, args);
      return existing._id;
    }
    return await ctx.db.insert('pullRequests', { ...args, reviewActive: false });
  },
});

/** Set the Sticky Opt-In `reviewActive` flag for a PR. */
export const setReviewActive = mutation({
  args: { pullRequestId: v.id('pullRequests'), active: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { pullRequestId, active }) => {
    await ctx.db.patch(pullRequestId, { reviewActive: active });
    return null;
  },
});

/** Mark a PR closed and clear its `reviewActive` flag. */
export const clearOnClose = mutation({
  args: { pullRequestId: v.id('pullRequests') },
  returns: v.null(),
  handler: async (ctx, { pullRequestId }) => {
    await ctx.db.patch(pullRequestId, { state: 'closed', reviewActive: false });
    return null;
  },
});
