import { v } from 'convex/values';
import { doc } from 'convex-helpers/validators';
import { internal } from './_generated/api.js';
import type { Id } from './_generated/dataModel.js';
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server.js';
import { labelFromFindingSummary } from './archetypeLabels.js';
import { clampLimit } from './limits.js';
import schema, { FINDING_EMBEDDING_DIMENSIONS } from './schema.js';
import { action, mutation, query } from './serviceFunctions.js';

const ARCHETYPE_SIMILARITY_THRESHOLD = 0.8;
const MAX_EXAMPLE_FINDING_IDS = 5;
const DEFAULT_ARCHETYPE_QUERY_LIMIT = 50;

type AssignmentContext = {
  scopeKey: string;
  currentArchetypeId?: Id<'archetypes'>;
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
  returns: v.array(doc(schema, 'archetypes')),
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
  handler: async () => {
    return { attempted: 0, clustered: 0, failed: 0 };
  },
});

export const assignmentContext = internalQuery({
  args: { findingId: v.id('findings') },
  returns: v.union(
    v.object({
      scopeKey: v.string(),
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
    const scopeKey = archetypeScopeKey(productId, finding.agentKey);
    if (finding.archetypeId !== undefined) {
      return {
        scopeKey,
        currentArchetypeId: finding.archetypeId,
      };
    }
    return { scopeKey };
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

    const scopeKey = archetypeScopeKey(productId, finding.agentKey);

    if (matchedArchetypeId !== undefined) {
      const matched = await ctx.db.get(matchedArchetypeId);
      if (matched !== null && matched.scopeKey === scopeKey) {
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
      agentKey: finding.agentKey,
      scopeKey,
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
    });
  }

  const nearest = await ctx.vectorSearch('archetypes', 'by_exemplar_embedding_and_scope_key', {
    vector: args.embedding,
    limit: 1,
    filter: (q) => q.eq('scopeKey', context.scopeKey),
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

// Convex vector filters support equality/or expressions, so this encodes the
// exact (productId, agentKey) bucket as one equality-filterable field.
function archetypeScopeKey(productId: Id<'products'>, agentKey: string): string {
  return JSON.stringify([productId, agentKey]);
}

function ensureEmbeddingDimensions(embedding: number[]): void {
  if (embedding.length !== FINDING_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Finding embedding had ${embedding.length} dimensions; expected ${FINDING_EMBEDDING_DIMENSIONS}`,
    );
  }
}
