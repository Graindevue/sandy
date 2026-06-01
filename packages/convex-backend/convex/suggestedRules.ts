import { v } from 'convex/values';
import { api, internal } from './_generated/api.js';
import type { Id } from './_generated/dataModel.js';
import { internalAction, internalQuery, mutation, query } from './_generated/server.js';
import { clampLimit } from './limits.js';
import { type RecentArchetypeReaction, recentArchetypeReactions } from './reactionEvidence.js';
import {
  draftSuggestedRuleDescription,
  evidenceMeetsSuggestedRuleThreshold,
  fallbackDraftDescription,
  NEGATIVE_REACTION_THRESHOLD,
  type ReactionEvidenceScore,
  type ReactionForInference,
  reactionForInference,
  scoreReactionEvidence,
} from './suggestedRuleInference.js';

export { draftSuggestedRuleDescription, scoreReactionEvidence } from './suggestedRuleInference.js';

const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 200;
const DEFAULT_CANDIDATE_LIMIT = 100;
const MAX_CANDIDATE_LIMIT = 500;
const DEFAULT_RECENT_REACTION_LIMIT = 100;
const MAX_RECENT_REACTION_LIMIT = 200;

type CandidateArchetype = {
  archetypeId: Id<'archetypes'>;
  label: string;
};

/** SuggestedRules waiting for an operator decision. */
export const subscribePending = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query('suggestedRules')
      .withIndex('by_status', (q) => q.eq('status', 'suggested'))
      .order('desc')
      .take(clampLimit(limit, DEFAULT_PENDING_LIMIT, MAX_PENDING_LIMIT));
  },
});

/** Create a suppression SuggestedRule once reaction evidence crosses the threshold. */
export const createIfEvidenceThresholdMet = mutation({
  args: {
    sourceArchetypeId: v.id('archetypes'),
    description: v.string(),
    reactionLimit: v.optional(v.number()),
  },
  returns: v.union(v.id('suggestedRules'), v.null()),
  handler: async (
    ctx,
    { sourceArchetypeId, description, reactionLimit },
  ): Promise<Id<'suggestedRules'> | null> => {
    const archetype = await ctx.db.get(sourceArchetypeId);
    if (archetype === null) {
      throw new Error(`Archetype ${sourceArchetypeId} does not exist`);
    }

    const reactions = await inferenceReactionsForArchetype(ctx.db, {
      archetypeId: sourceArchetypeId,
      limit: reactionLimit,
    });
    const score = scoreReactionEvidence(reactions);
    await ctx.db.patch(sourceArchetypeId, { suppressionWeight: score.suppressionWeight });

    const existing = await ctx.db
      .query('suggestedRules')
      .withIndex('by_source_archetype', (q) => q.eq('sourceArchetypeId', sourceArchetypeId))
      .take(1);
    if (existing.length > 0 || !evidenceMeetsSuggestedRuleThreshold(score)) {
      return null;
    }

    return await ctx.db.insert('suggestedRules', {
      productId: archetype.productId,
      type: 'suppression',
      status: 'suggested',
      description,
      sourceArchetypeId,
      evidence: serializeEvidence(sourceArchetypeId, score),
    });
  },
});

/** Mark a SuggestedRule promoted after a worker applies the operator decision. */
export const markPromoted = mutation({
  args: {
    suggestedRuleId: v.id('suggestedRules'),
  },
  returns: v.null(),
  handler: async (ctx, { suggestedRuleId }) => {
    await ctx.db.patch(suggestedRuleId, { status: 'promoted' });
    return null;
  },
});

/** Daily cron target: infer draft SuggestedRules from repeated negative reactions. */
export const inferSuggestedRulesFromReactions = internalAction({
  args: {
    limit: v.optional(v.number()),
    reactionLimit: v.optional(v.number()),
  },
  returns: v.object({
    candidates: v.number(),
    created: v.number(),
    skipped: v.number(),
    failed: v.number(),
  }),
  handler: async (ctx, { limit, reactionLimit }) => {
    const candidates: CandidateArchetype[] = await ctx.runQuery(
      internal.suggestedRules.candidatesForReactionInference,
      limit === undefined ? {} : { limit },
    );
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        const recentReactions: RecentArchetypeReaction[] = await ctx.runQuery(
          api.reactions.recentByArchetype,
          {
            archetypeId: candidate.archetypeId,
            limit: reactionLimit ?? DEFAULT_RECENT_REACTION_LIMIT,
          },
        );
        const reactions = recentReactions.map(reactionForInference);
        const score = scoreReactionEvidence(reactions);
        const description = evidenceMeetsSuggestedRuleThreshold(score)
          ? await draftSuggestedRuleDescription({
              archetypeLabel: candidate.label,
              reactions,
            })
          : fallbackDraftDescription({ archetypeLabel: candidate.label, reactions });

        const suggestedRuleId: Id<'suggestedRules'> | null = await ctx.runMutation(
          api.suggestedRules.createIfEvidenceThresholdMet,
          {
            sourceArchetypeId: candidate.archetypeId,
            description,
            reactionLimit: reactionLimit ?? DEFAULT_RECENT_REACTION_LIMIT,
          },
        );
        if (suggestedRuleId === null) {
          skipped += 1;
        } else {
          created += 1;
        }
      } catch (error) {
        failed += 1;
        warn(`failed to infer SuggestedRule for Archetype ${candidate.archetypeId}`, error);
      }
    }

    return { candidates: candidates.length, created, skipped, failed };
  },
});

export const candidatesForReactionInference = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      archetypeId: v.id('archetypes'),
      label: v.string(),
    }),
  ),
  handler: async (ctx, { limit }): Promise<CandidateArchetype[]> => {
    const archetypes = await ctx.db
      .query('archetypes')
      .take(clampLimit(limit, DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT));
    const candidates: CandidateArchetype[] = [];
    for (const archetype of archetypes) {
      const existing = await ctx.db
        .query('suggestedRules')
        .withIndex('by_source_archetype', (q) => q.eq('sourceArchetypeId', archetype._id))
        .take(1);
      if (existing.length === 0) {
        candidates.push({ archetypeId: archetype._id, label: archetype.label });
      }
    }
    return candidates;
  },
});

async function inferenceReactionsForArchetype(
  db: Parameters<typeof recentArchetypeReactions>[0],
  {
    archetypeId,
    limit,
  }: {
    archetypeId: Id<'archetypes'>;
    limit: number | undefined;
  },
): Promise<ReactionForInference[]> {
  const resolvedLimit = clampLimit(limit, DEFAULT_RECENT_REACTION_LIMIT, MAX_RECENT_REACTION_LIMIT);
  const reactions = await recentArchetypeReactions(db, { archetypeId, limit: resolvedLimit });
  return reactions.map(reactionForInference);
}

function serializeEvidence(
  sourceArchetypeId: Id<'archetypes'>,
  score: ReactionEvidenceScore,
): string {
  return JSON.stringify({
    source: 'reactions',
    sourceArchetypeId,
    threshold: NEGATIVE_REACTION_THRESHOLD,
    negativeScore: score.negativeScore,
    totalScore: score.totalScore,
    suppressionWeight: score.suppressionWeight,
    reactions: score.supportingReactions,
  });
}

function warn(message: string, error: unknown): void {
  (globalThis as { console?: { warn(message: string, error: unknown): void } }).console?.warn(
    message,
    error,
  );
}
