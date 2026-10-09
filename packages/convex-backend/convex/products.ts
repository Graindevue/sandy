import { v } from 'convex/values';
import { mutation } from './serviceFunctions.js';

/**
 * Reconcile one Product and its Repos from `.config/bot.yaml` into Convex. This
 * supersedes the webhook front door's single-Repo auto-provisioning
 * ({@link pullRequests.ensureRepo}, TODO #5): that path puts every newly seen
 * Repo in its own single-Repo Product, so two Repos declared under one Product
 * in `bot.yaml` would never share a Product in Convex and cross-repo Reviews
 * could not see siblings.
 *
 * Called for each configured Product at worker startup. Upserts the Product by
 * `slug` and (re)points every listed Repo at it — moving a Repo that the webhook
 * path previously parked in an auto-Product into its real Product. Idempotent, so
 * it is safe to run on every boot and after a config reload.
 */
export const syncProduct = mutation({
  args: {
    slug: v.string(),
    name: v.string(),
    repos: v.array(
      v.object({
        owner: v.string(),
        name: v.string(),
        fullName: v.string(),
        defaultBranch: v.string(),
      }),
    ),
  },
  returns: v.id('products'),
  handler: async (ctx, { slug, name, repos }) => {
    const existingProduct = await ctx.db
      .query('products')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();

    if (existingProduct !== null && existingProduct.name !== name) {
      await ctx.db.patch(existingProduct._id, { name });
    }
    const productId = existingProduct?._id ?? (await ctx.db.insert('products', { slug, name }));

    for (const repo of repos) {
      const existingRepo = await ctx.db
        .query('repos')
        .withIndex('by_full_name', (q) => q.eq('fullName', repo.fullName))
        .unique();
      if (existingRepo === null) {
        await ctx.db.insert('repos', {
          productId,
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
        });
      } else {
        await ctx.db.patch(existingRepo._id, {
          productId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
        });
      }
    }

    // Config is the source of truth: a Repo previously grouped under this Product
    // but no longer listed (removed from bot.yaml) is moved to its own single-Repo
    // Product, so it stops being a sibling for the remaining Repos' Reviews —
    // without deleting its Review history (its reviewJobs/findings keep repoId).
    const listed = new Set(repos.map((repo) => repo.fullName));
    const grouped = await ctx.db
      .query('repos')
      .withIndex('by_product', (q) => q.eq('productId', productId))
      .collect();
    for (const repo of grouped) {
      if (listed.has(repo.fullName)) {
        continue;
      }
      const ownProduct = await ctx.db
        .query('products')
        .withIndex('by_slug', (q) => q.eq('slug', repo.fullName))
        .unique();
      const ownProductId =
        ownProduct?._id ??
        (await ctx.db.insert('products', { slug: repo.fullName, name: repo.fullName }));
      await ctx.db.patch(repo._id, { productId: ownProductId });
    }

    return productId;
  },
});
