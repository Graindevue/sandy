import { v } from 'convex/values';
import { mutation, query } from './_generated/server.js';
import { pullRequestState } from './validators.js';

/**
 * Resolve a Repo by `owner/name`, creating it — and a single-Repo Product to hold
 * it — on first observation, then return its id. Lets the webhook front door turn
 * a payload's `owner/name` into a `repoId` for {@link upsert} before config is
 * applied.
 *
 * This is the bootstrap/fallback path for a Repo not (yet) covered by config. A
 * Repo declared in `.config/bot.yaml` is regrouped under its real Product by
 * `products.syncProduct`, which the worker runs at startup — config is the source
 * of truth for Product/Repo grouping.
 */
export const ensureRepo = mutation({
  args: { owner: v.string(), name: v.string(), defaultBranch: v.optional(v.string()) },
  returns: v.id('repos'),
  handler: async (ctx, { owner, name, defaultBranch }) => {
    const fullName = `${owner}/${name}`;
    const existing = await ctx.db
      .query('repos')
      .withIndex('by_full_name', (q) => q.eq('fullName', fullName))
      .unique();
    if (existing !== null) {
      return existing._id;
    }
    // A Repo grouped with siblings in bot.yaml is regrouped under its shared
    // Product by products.syncProduct at worker startup; here (webhook front door,
    // possibly before that runs) it bootstraps as its own single-Repo Product.
    const productId = await ctx.db.insert('products', { slug: fullName, name: fullName });
    return await ctx.db.insert('repos', {
      productId,
      owner,
      name,
      fullName,
      defaultBranch: defaultBranch ?? 'main',
    });
  },
});

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

/**
 * Look up a PullRequest by `(repo, number)`. Returns `null` when Sandy has never
 * seen the PR. The webhook front door reads `reviewActive` from this to evaluate
 * Sticky Opt-In on events (e.g. `synchronize`) that carry the full PR but not the
 * stored flag.
 */
export const get = query({
  args: { repoId: v.id('repos'), number: v.number() },
  handler: async (ctx, { repoId, number }) => {
    return await ctx.db
      .query('pullRequests')
      .withIndex('by_repo_and_number', (q) => q.eq('repoId', repoId).eq('number', number))
      .unique();
  },
});

/** Merged PRs whose passive merge-state signals have not been rolled up yet. */
export const listMergedForMergeStateBackfill = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      pullRequestId: v.id('pullRequests'),
      repo: v.object({ owner: v.string(), name: v.string() }),
      pullNumber: v.number(),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const pullRequests = await ctx.db
      .query('pullRequests')
      .withIndex('by_state_and_merge_state_signals_rolled_up_at', (q) =>
        q.eq('state', 'merged').eq('mergeStateSignalsRolledUpAt', undefined),
      )
      .take(clampBackfillLimit(limit));

    const result: Array<{
      pullRequestId: (typeof pullRequests)[number]['_id'];
      repo: { owner: string; name: string };
      pullNumber: number;
    }> = [];
    for (const pullRequest of pullRequests) {
      const repo = await ctx.db.get(pullRequest.repoId);
      if (repo !== null) {
        result.push({
          pullRequestId: pullRequest._id,
          repo: { owner: repo.owner, name: repo.name },
          pullNumber: pullRequest.number,
        });
      }
    }
    return result;
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

/** Clear the Sticky Opt-In `reviewActive` flag after a PR closes. */
export const clearOnClose = mutation({
  args: { pullRequestId: v.id('pullRequests') },
  returns: v.null(),
  handler: async (ctx, { pullRequestId }) => {
    await ctx.db.patch(pullRequestId, { reviewActive: false });
    return null;
  },
});

/** Mark that merge-state inference completed for a merged PR. */
export const markMergeStateSignalsRolledUp = mutation({
  args: { pullRequestId: v.id('pullRequests'), rolledUpAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { pullRequestId, rolledUpAt }) => {
    await ctx.db.patch(pullRequestId, { mergeStateSignalsRolledUpAt: rolledUpAt });
    return null;
  },
});

function clampBackfillLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 25;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
