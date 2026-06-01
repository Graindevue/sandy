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
