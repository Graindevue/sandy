import { v } from 'convex/values';
import { internal } from './_generated/api.js';
import type { Id } from './_generated/dataModel.js';
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server.js';
import { labelFromFindingSummary } from './archetypeLabels.js';
import { clampLimit } from './limits.js';
import { embedFindingSummary } from './openaiEmbeddings.js';
import { TEXT_EMBEDDING_3_SMALL_DIMENSIONS } from './schema.js';

const ARCHETYPE_SIMILARITY_THRESHOLD = 0.85;
const MAX_EXAMPLE_FINDING_IDS = 5;
const DEFAULT_ARCHETYPE_QUERY_LIMIT = 50;
const DEFAULT_CLUSTER_BATCH_SIZE = 20;
const MAX_CLUSTER_BATCH_SIZE = 50;

type AssignmentContext = {
  productId: Id<'products'>;
  currentArchetypeId?: Id<'archetypes'>;
};

type UnclusteredFinding = {
  _id: Id<'findings'>;
  summary: string;
};

type AssignmentResult = {
  archetypeId: Id<'archetypes'>;
  suppressionWeight: number;
};

const assignmentResult = v.object({
  archetypeId: v.id('archetypes'),
  suppressionWeight: v.number(),
});

export const assignOrCreateArchetype = action({
  args: {
    findingId: v.id('findings'),
    embedding: v.array(v.float64()),
  },
  returns: assignmentResult,
  handler: async (ctx, args): Promise<AssignmentResult> => {
    return await assignEmbeddingToArchetype(ctx, args);
  },
});

export const byProduct = query({
  args: {
    productId: v.id('products'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { productId, limit }) => {
    return await ctx.db
      .query('archetypes')
      .withIndex('by_product', (q) => q.eq('productId', productId))
      .take(clampLimit(limit, DEFAULT_ARCHETYPE_QUERY_LIMIT, 256));
  },
});

export const updateSuppressionWeight = mutation({
  args: {
    archetypeId: v.id('archetypes'),
    suppressionWeight: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { archetypeId, suppressionWeight }) => {
    if (suppressionWeight < 0 || suppressionWeight > 1) {
      throw new Error('suppressionWeight must be between 0 and 1');
    }
    await ctx.db.patch(archetypeId, { suppressionWeight });
    return null;
  },
});

export const clusterRecentFindings = internalAction({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.object({
    attempted: v.number(),
    clustered: v.number(),
    failed: v.number(),
  }),
  handler: async (ctx, { limit }) => {
    const findings: UnclusteredFinding[] = await ctx.runQuery(
      internal.archetypes.unclusteredFindings,
      limit === undefined ? {} : { limit },
    );
    let clustered = 0;
    let failed = 0;

    for (const finding of findings) {
      try {
        const embedding = await embedFindingSummary(finding.summary);
        await assignEmbeddingToArchetype(ctx, { findingId: finding._id, embedding });
        clustered += 1;
      } catch (error) {
        failed += 1;
        warn(`failed to cluster Finding ${finding._id}`, error);
      }
    }

    return { attempted: findings.length, clustered, failed };
  },
});

export const assignmentContext = internalQuery({
  args: { findingId: v.id('findings') },
  returns: v.union(
    v.object({
      productId: v.id('products'),
      currentArchetypeId: v.optional(v.id('archetypes')),
    }),
    v.null(),
  ),
  handler: async (ctx, { findingId }): Promise<AssignmentContext | null> => {
    const finding = await ctx.db.get(findingId);
    if (finding === null) {
      return null;
    }
    const productId = await productIdForFinding(ctx, finding.pullRequestId);
    if (productId === null) {
      return null;
    }
    if (finding.archetypeId !== undefined) {
      return { productId, currentArchetypeId: finding.archetypeId };
    }
    return { productId };
  },
});

export const unclusteredFindings = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id('findings'),
      summary: v.string(),
    }),
  ),
  handler: async (ctx, { limit }): Promise<UnclusteredFinding[]> => {
    const findings = await ctx.db
      .query('findings')
      .withIndex('by_archetype', (q) => q.eq('archetypeId', undefined))
      .take(clampLimit(limit, DEFAULT_CLUSTER_BATCH_SIZE, MAX_CLUSTER_BATCH_SIZE));
    return findings.map((finding) => ({ _id: finding._id, summary: finding.summary }));
  },
});

export const persistAssignment = internalMutation({
  args: {
    findingId: v.id('findings'),
    embedding: v.array(v.float64()),
    matchedArchetypeId: v.optional(v.id('archetypes')),
  },
  returns: assignmentResult,
  handler: async (ctx, { findingId, embedding, matchedArchetypeId }): Promise<AssignmentResult> => {
    ensureEmbeddingDimensions(embedding);
    const finding = await ctx.db.get(findingId);
    if (finding === null) {
      throw new Error(`Finding ${findingId} does not exist`);
    }
    if (finding.archetypeId !== undefined) {
      const archetype = await ctx.db.get(finding.archetypeId);
      if (archetype === null) {
        throw new Error(`Finding ${findingId} references missing Archetype ${finding.archetypeId}`);
      }
      await ctx.db.patch(findingId, { embedding });
      return assignmentResultFor(archetype);
    }

    const productId = await productIdForFinding(ctx, finding.pullRequestId);
    if (productId === null) {
      throw new Error(`Finding ${findingId} is not linked to a Product`);
    }

    if (matchedArchetypeId !== undefined) {
      const matched = await ctx.db.get(matchedArchetypeId);
      if (matched !== null && matched.productId === productId) {
        const exampleFindingIds = appendExampleFindingId(matched.exampleFindingIds, findingId);
        await ctx.db.patch(findingId, { embedding, archetypeId: matchedArchetypeId });
        await ctx.db.patch(matchedArchetypeId, {
          count: matched.count + 1,
          exampleFindingIds,
        });
        return assignmentResultFor(matched);
      }
    }

    const suppressionWeight = 0;
    const archetypeId = await ctx.db.insert('archetypes', {
      productId,
      label: labelFromFindingSummary(finding.summary),
      exemplarEmbedding: embedding,
      exampleFindingIds: [findingId],
      count: 1,
      suppressionWeight,
    });
    await ctx.db.patch(findingId, { embedding, archetypeId });
    return { archetypeId, suppressionWeight };
  },
});

async function assignEmbeddingToArchetype(
  ctx: ActionCtx,
  args: {
    findingId: Id<'findings'>;
    embedding: number[];
  },
): Promise<AssignmentResult> {
  ensureEmbeddingDimensions(args.embedding);
  const context: AssignmentContext | null = await ctx.runQuery(
    internal.archetypes.assignmentContext,
    { findingId: args.findingId },
  );
  if (context === null) {
    throw new Error(`Finding ${args.findingId} does not exist or is missing Product context`);
  }
  if (context.currentArchetypeId !== undefined) {
    return await ctx.runMutation(internal.archetypes.persistAssignment, {
      findingId: args.findingId,
      embedding: args.embedding,
      matchedArchetypeId: context.currentArchetypeId,
    });
  }

  const nearest = await ctx.vectorSearch('archetypes', 'by_exemplar_embedding_and_product', {
    vector: args.embedding,
    limit: 1,
    filter: (q) => q.eq('productId', context.productId),
  });
  const match = nearest[0];
  const matchedArchetypeId =
    match !== undefined && match._score >= ARCHETYPE_SIMILARITY_THRESHOLD ? match._id : undefined;

  return await ctx.runMutation(internal.archetypes.persistAssignment, {
    findingId: args.findingId,
    embedding: args.embedding,
    ...(matchedArchetypeId === undefined ? {} : { matchedArchetypeId }),
  });
}

async function productIdForFinding(
  ctx: {
    db: {
      get<T extends 'pullRequests' | 'repos'>(
        id: Id<T>,
      ): Promise<
        (T extends 'pullRequests' ? { repoId: Id<'repos'> } : { productId: Id<'products'> }) | null
      >;
    };
  },
  pullRequestId: Id<'pullRequests'>,
): Promise<Id<'products'> | null> {
  const pullRequest = await ctx.db.get(pullRequestId);
  if (pullRequest === null) {
    return null;
  }
  const repo = await ctx.db.get(pullRequest.repoId);
  return repo?.productId ?? null;
}

function appendExampleFindingId(
  existing: Id<'findings'>[],
  findingId: Id<'findings'>,
): Id<'findings'>[] {
  if (existing.includes(findingId)) {
    return existing;
  }
  return [...existing, findingId].slice(0, MAX_EXAMPLE_FINDING_IDS);
}

function assignmentResultFor(archetype: {
  _id: Id<'archetypes'>;
  suppressionWeight: number;
}): AssignmentResult {
  return { archetypeId: archetype._id, suppressionWeight: archetype.suppressionWeight };
}

function ensureEmbeddingDimensions(embedding: number[]): void {
  if (embedding.length !== TEXT_EMBEDDING_3_SMALL_DIMENSIONS) {
    throw new Error(
      `Finding embedding had ${embedding.length} dimensions; expected ${TEXT_EMBEDDING_3_SMALL_DIMENSIONS}`,
    );
  }
}

function warn(message: string, error: unknown): void {
  (globalThis as { console?: { warn(message: string, error: unknown): void } }).console?.warn(
    message,
    error,
  );
}
