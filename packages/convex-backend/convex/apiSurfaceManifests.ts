import { v } from 'convex/values';
import type { Id } from './_generated/dataModel.js';
import { mutation } from './_generated/server.js';

export const API_SURFACE_MANIFEST_RETENTION = 20;

interface ManifestForRetention {
  _id: string;
  builtAt: number;
}

/** Persist one ApiSurfaceManifest and cap the Product's audit log at the newest 20. */
export const record = mutation({
  args: {
    productId: v.id('products'),
    repoShas: v.array(
      v.object({
        repo: v.string(),
        sha: v.string(),
      }),
    ),
    markdown: v.string(),
    builtAt: v.number(),
  },
  returns: v.id('apiSurfaceManifests'),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert('apiSurfaceManifests', args);
    const manifests = await ctx.db
      .query('apiSurfaceManifests')
      .withIndex('by_product_and_built_at', (q) => q.eq('productId', args.productId))
      .order('desc')
      .collect();
    for (const staleId of selectManifestIdsToPrune(manifests)) {
      await ctx.db.delete(staleId as Id<'apiSurfaceManifests'>);
    }
    return id;
  },
});

export function selectManifestIdsToPrune<T extends ManifestForRetention>(manifests: T[]): string[] {
  return [...manifests]
    .sort((a, b) => b.builtAt - a.builtAt)
    .slice(API_SURFACE_MANIFEST_RETENTION)
    .map((manifest) => manifest._id);
}
