import { v } from 'convex/values';
import { api, internal } from './_generated/api.js';
import type { Doc, Id } from './_generated/dataModel.js';
import {
  internalAction,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from './_generated/server.js';
import { clampLimit } from './limits.js';
import { type RecentArchetypeReaction, recentArchetypeReactions } from './reactionEvidence.js';
import { insertPendingReviewJob } from './reviewJobWrites.js';
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
import { pullRequestState, suggestedRuleStatus } from './validators.js';

export { draftSuggestedRuleDescription, scoreReactionEvidence } from './suggestedRuleInference.js';

const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 200;
const DEFAULT_CANDIDATE_LIMIT = 100;
const MAX_CANDIDATE_LIMIT = 500;
const DEFAULT_RECENT_REACTION_LIMIT = 100;
const MAX_RECENT_REACTION_LIMIT = 200;
const DEFAULT_PROMOTION_EXEMPLAR_LIMIT = 5;
const MAX_PROMOTION_EXEMPLAR_LIMIT = 10;
const MAX_PROMOTION_FINDINGS = 100;
const MAX_PRODUCT_REPOS = 100;

type CandidateArchetype = {
  archetypeId: Id<'archetypes'>;
  label: string;
};

type PositivePromotionFinding = Pick<
  Doc<'findings'>,
  '_id' | 'summary' | 'evidence' | 'category' | 'anchor'
>;

type PositivePromotionPullRequest = Pick<
  Doc<'pullRequests'>,
  'number' | 'state' | 'draft' | 'headSha' | 'baseRef' | 'title' | 'author' | 'url'
>;

/** SuggestedRules waiting for an operator decision. */
export const subscribePending = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit }) => {
    const boundedLimit = clampLimit(limit, DEFAULT_PENDING_LIMIT, MAX_PENDING_LIMIT);
    return await ctx.db
      .query('suggestedRules')
      .withIndex('by_status', (q) => q.eq('status', 'suggested'))
      .order('desc')
      .take(boundedLimit);
  },
});

/** Suppression SuggestedRules where an operator decision is waiting for worker promotion. */
export const subscribeSuppressionPromotions = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query('suggestedRules')
      .withIndex('by_status', (q) => q.eq('status', 'promoteToSuppression'))
      .order('desc')
      .take(clampLimit(limit, DEFAULT_PENDING_LIMIT, MAX_PENDING_LIMIT));
  },
});

/** Positive SuggestedRules where an operator decision is waiting for worker promotion. */
export const subscribePositivePromotions = query({
  args: {
    limit: v.optional(v.number()),
    exemplarLimit: v.optional(v.number()),
  },
  handler: async (ctx, { limit, exemplarLimit }) => {
    const rules = await ctx.db
      .query('suggestedRules')
      .withIndex('by_status', (q) => q.eq('status', 'promoteToPositive'))
      .order('desc')
      .take(clampLimit(limit, DEFAULT_PENDING_LIMIT, MAX_PENDING_LIMIT));
    const promotions = [];
    for (const rule of rules) {
      const archetype = await ctx.db.get(rule.sourceArchetypeId);
      if (archetype === null) {
        continue;
      }

      const [productRepos, recentFindings] = await Promise.all([
        ctx.db
          .query('repos')
          .withIndex('by_product', (q) => q.eq('productId', rule.productId))
          .take(MAX_PRODUCT_REPOS),
        ctx.db
          .query('findings')
          .withIndex('by_archetype', (q) => q.eq('archetypeId', rule.sourceArchetypeId))
          .order('desc')
          .take(MAX_PROMOTION_FINDINGS),
      ]);
      const targetRepo = mostAffectedRepo(productRepos, recentFindings);
      if (targetRepo === null) {
        continue;
      }

      const exemplarCount = clampLimit(
        exemplarLimit,
        DEFAULT_PROMOTION_EXEMPLAR_LIMIT,
        MAX_PROMOTION_EXEMPLAR_LIMIT,
      );
      const exemplars = await promotionExemplars(ctx.db, archetype, recentFindings, exemplarCount);
      if (exemplars.length === 0) {
        continue;
      }

      promotions.push({
        _id: rule._id,
        description: rule.description,
        sourceArchetypeId: rule.sourceArchetypeId,
        archetypeLabel: archetype.label,
        targetRepo: {
          _id: targetRepo._id,
          owner: targetRepo.owner,
          name: targetRepo.name,
          fullName: targetRepo.fullName,
          defaultBranch: targetRepo.defaultBranch,
        },
        exemplars: exemplars.map((finding) => ({
          findingId: finding._id,
          summary: finding.summary,
          evidence: finding.evidence,
          category: finding.category,
          anchor: finding.anchor,
        })),
      });
    }
    return promotions;
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

/** Apply a suppression promotion in one transaction and mark the SuggestedRule promoted. */
export const promoteSuppression = mutation({
  args: {
    suggestedRuleId: v.id('suggestedRules'),
  },
  returns: v.boolean(),
  handler: async (ctx, { suggestedRuleId }) => {
    const suggestedRule = await ctx.db.get(suggestedRuleId);
    if (suggestedRule === null) {
      throw new Error(`SuggestedRule ${suggestedRuleId} does not exist`);
    }
    if (suggestedRule.status !== 'promoteToSuppression') {
      return false;
    }

    await ctx.db.patch(suggestedRule.sourceArchetypeId, { suppressionWeight: 1 });
    await ctx.db.patch(suggestedRuleId, { status: 'promoted' });
    return true;
  },
});

/** Mark a SuggestedRule promoted after an external promotion action succeeds. */
export const markPromoted = mutation({
  args: {
    suggestedRuleId: v.id('suggestedRules'),
    expectedStatus: v.optional(suggestedRuleStatus),
  },
  returns: v.boolean(),
  handler: async (ctx, { suggestedRuleId, expectedStatus }) => {
    const suggestedRule = await ctx.db.get(suggestedRuleId);
    if (suggestedRule === null) {
      throw new Error(`SuggestedRule ${suggestedRuleId} does not exist`);
    }
    if (expectedStatus !== undefined && suggestedRule.status !== expectedStatus) {
      return false;
    }
    await ctx.db.patch(suggestedRuleId, { status: 'promoted' });
    return true;
  },
});

/** Record the PR Sandy opened for a positive SuggestedRule and opt it into Review. */
export const recordPositivePromotion = mutation({
  args: {
    suggestedRuleId: v.id('suggestedRules'),
    repoId: v.id('repos'),
    pullRequest: v.object({
      number: v.number(),
      state: pullRequestState,
      draft: v.boolean(),
      headSha: v.string(),
      baseRef: v.string(),
      title: v.string(),
      author: v.string(),
      url: v.string(),
    }),
    agentKeys: v.array(v.string()),
  },
  returns: v.object({
    promoted: v.boolean(),
    pullRequestId: v.id('pullRequests'),
    reviewJobId: v.id('reviewJobs'),
  }),
  handler: async (ctx, { suggestedRuleId, repoId, pullRequest, agentKeys }) => {
    const suggestedRule = await ctx.db.get(suggestedRuleId);
    if (suggestedRule === null) {
      throw new Error(`SuggestedRule ${suggestedRuleId} does not exist`);
    }

    const pullRequestId = await upsertReviewActivePullRequest(ctx, repoId, pullRequest);
    const reviewJobId = await insertPendingReviewJob(ctx, {
      pullRequestId,
      repoId,
      headSha: pullRequest.headSha,
      trigger: 'opened',
      agentKeys,
    });

    if (suggestedRule.status !== 'promoteToPositive') {
      return { promoted: false, pullRequestId, reviewJobId };
    }

    await ctx.db.patch(suggestedRuleId, { status: 'promoted' });
    return { promoted: true, pullRequestId, reviewJobId };
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

function mostAffectedRepo(
  repos: readonly Doc<'repos'>[],
  findings: readonly Pick<Doc<'findings'>, 'anchor'>[],
): Doc<'repos'> | null {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.anchor.repo, (counts.get(finding.anchor.repo) ?? 0) + 1);
  }

  let winner: Doc<'repos'> | null = null;
  let winnerCount = 0;
  for (const repo of repos) {
    const count = counts.get(repo.fullName) ?? 0;
    if (count > winnerCount) {
      winner = repo;
      winnerCount = count;
    }
  }
  return winnerCount === 0 ? null : winner;
}

async function upsertReviewActivePullRequest(
  ctx: MutationCtx,
  repoId: Id<'repos'>,
  pullRequest: PositivePromotionPullRequest,
): Promise<Id<'pullRequests'>> {
  const existing = await ctx.db
    .query('pullRequests')
    .withIndex('by_repo_and_number', (q) => q.eq('repoId', repoId).eq('number', pullRequest.number))
    .unique();
  const fields = { repoId, ...pullRequest, reviewActive: true };
  if (existing !== null) {
    await ctx.db.patch(existing._id, fields);
    return existing._id;
  }
  return await ctx.db.insert('pullRequests', fields);
}

async function promotionExemplars(
  db: {
    get<T extends 'findings'>(id: Id<T>): Promise<Doc<T> | null>;
  },
  archetype: Pick<Doc<'archetypes'>, 'exampleFindingIds'>,
  recentFindings: readonly PositivePromotionFinding[],
  limit: number,
): Promise<PositivePromotionFinding[]> {
  const seen = new Set<string>();
  const exemplars: PositivePromotionFinding[] = [];
  for (const findingId of archetype.exampleFindingIds) {
    if (exemplars.length >= limit) {
      break;
    }
    const finding = await db.get(findingId);
    if (finding === null || seen.has(finding._id)) {
      continue;
    }
    seen.add(finding._id);
    exemplars.push(finding);
  }

  for (const finding of recentFindings) {
    if (exemplars.length >= limit) {
      break;
    }
    if (seen.has(finding._id)) {
      continue;
    }
    seen.add(finding._id);
    exemplars.push(finding);
  }
  return exemplars;
}

function warn(message: string, error: unknown): void {
  (globalThis as { console?: { warn(message: string, error: unknown): void } }).console?.warn(
    message,
    error,
  );
}
