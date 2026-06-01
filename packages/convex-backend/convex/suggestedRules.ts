import type { ReactionKind } from '@sandy/shared-types';
import { v } from 'convex/values';
import { api, internal } from './_generated/api.js';
import type { Id } from './_generated/dataModel.js';
import {
  internalAction,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from './_generated/server.js';

const NEGATIVE_REACTION_THRESHOLD = 3;
const MERGED_IGNORED_NEGATIVE_WEIGHT = 1 / 3;
const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 200;
const DEFAULT_CANDIDATE_LIMIT = 100;
const MAX_CANDIDATE_LIMIT = 500;
const DEFAULT_RECENT_REACTION_LIMIT = 100;
const MAX_RECENT_REACTION_LIMIT = 200;
const MAX_FINDINGS_PER_ARCHETYPE = 200;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_ANTHROPIC_DRAFT_MODEL = 'claude-3-5-haiku-latest';

type ReactionForInference = {
  reactionId: string;
  findingId: string;
  kind: ReactionKind;
  replyText?: string;
  findingSummary: string;
  createdAt: number;
};

type SupportingReaction = {
  reactionId: string;
  findingId: string;
  kind: ReactionKind;
  weight: number;
  replyText?: string;
};

type ReactionEvidenceScore = {
  negativeScore: number;
  totalScore: number;
  suppressionWeight: number;
  supportingReactions: SupportingReaction[];
};

type CandidateArchetype = {
  archetypeId: Id<'archetypes'>;
  label: string;
};

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

type AnthropicMessageResponse = {
  content?: Array<{
    type?: unknown;
    text?: unknown;
  }>;
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

    const reactions = await reactionsForArchetype(ctx, sourceArchetypeId, reactionLimit);
    const score = scoreReactionEvidence(reactions);
    await ctx.db.patch(sourceArchetypeId, { suppressionWeight: score.suppressionWeight });

    const existing = await ctx.db
      .query('suggestedRules')
      .withIndex('by_source_archetype', (q) => q.eq('sourceArchetypeId', sourceArchetypeId))
      .take(1);
    if (existing.length > 0 || score.negativeScore < NEGATIVE_REACTION_THRESHOLD) {
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
        const recentReactions: Array<{
          _id: Id<'reactions'>;
          _creationTime: number;
          findingId: Id<'findings'>;
          kind: ReactionKind;
          replyText?: string;
          findingSummary: string;
        }> = await ctx.runQuery(api.reactions.recentByArchetype, {
          archetypeId: candidate.archetypeId,
          limit: reactionLimit ?? DEFAULT_RECENT_REACTION_LIMIT,
        });
        const reactions = recentReactions.map(reactionForInference);
        const score = scoreReactionEvidence(reactions);
        const description =
          score.negativeScore >= NEGATIVE_REACTION_THRESHOLD
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

export function scoreReactionEvidence(
  reactions: readonly ReactionForInference[],
): ReactionEvidenceScore {
  let negativeScore = 0;
  let totalScore = 0;
  const supportingReactions: SupportingReaction[] = [];

  for (const reaction of reactions) {
    const negativeWeight = negativeWeightForKind(reaction.kind);
    const totalWeight = totalWeightForKind(reaction.kind);
    negativeScore += negativeWeight;
    totalScore += totalWeight;

    if (negativeWeight > 0 || reaction.replyText !== undefined) {
      supportingReactions.push({
        reactionId: reaction.reactionId,
        findingId: reaction.findingId,
        kind: reaction.kind,
        weight: negativeWeight,
        ...(reaction.replyText === undefined ? {} : { replyText: reaction.replyText }),
      });
    }
  }

  return {
    negativeScore,
    totalScore,
    suppressionWeight: totalScore === 0 ? 0 : negativeScore / totalScore,
    supportingReactions,
  };
}

export async function draftSuggestedRuleDescription(input: {
  archetypeLabel: string;
  reactions: readonly ReactionForInference[];
}): Promise<string> {
  const fallback = fallbackDraftDescription(input);
  const apiKey = anthropicApiKeyFromEnv();
  if (apiKey === null) {
    return fallback;
  }

  try {
    const response = await globalFetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model: anthropicDraftModelFromEnv(),
        max_tokens: 180,
        temperature: 0.2,
        system:
          'Draft concise code-review bot rules from reviewer feedback. Return one actionable sentence only.',
        messages: [
          {
            role: 'user',
            content: buildDraftPrompt(input),
          },
        ],
      }),
    });
    if (!response.ok) {
      warn(
        `Anthropic SuggestedRule draft request failed with ${response.status}`,
        await response.text(),
      );
      return fallback;
    }

    const body = (await response.json()) as AnthropicMessageResponse;
    const text = firstAnthropicText(body);
    const normalized = text?.trim();
    return normalized === undefined || normalized.length === 0 ? fallback : normalized;
  } catch (error) {
    warn('Anthropic SuggestedRule draft request failed', error);
    return fallback;
  }
}

function firstAnthropicText(body: AnthropicMessageResponse): string | undefined {
  for (const part of body.content ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') {
      return part.text;
    }
  }
  return undefined;
}

async function reactionsForArchetype(
  ctx: MutationCtx,
  archetypeId: Id<'archetypes'>,
  limit: number | undefined,
): Promise<ReactionForInference[]> {
  const resolvedLimit = clampLimit(limit, DEFAULT_RECENT_REACTION_LIMIT, MAX_RECENT_REACTION_LIMIT);
  const findings = await ctx.db
    .query('findings')
    .withIndex('by_archetype', (q) => q.eq('archetypeId', archetypeId))
    .take(MAX_FINDINGS_PER_ARCHETYPE);

  const reactions: ReactionForInference[] = [];
  for (const finding of findings) {
    const findingReactions = await ctx.db
      .query('reactions')
      .withIndex('by_finding', (q) => q.eq('findingId', finding._id))
      .take(resolvedLimit);
    for (const reaction of findingReactions) {
      reactions.push({
        reactionId: reaction._id,
        findingId: reaction.findingId,
        kind: reaction.kind,
        ...(reaction.replyText === undefined ? {} : { replyText: reaction.replyText }),
        findingSummary: finding.summary,
        createdAt: reaction._creationTime,
      });
    }
  }

  return reactions.sort((left, right) => right.createdAt - left.createdAt).slice(0, resolvedLimit);
}

function reactionForInference(reaction: {
  _id: Id<'reactions'>;
  _creationTime: number;
  findingId: Id<'findings'>;
  kind: ReactionKind;
  replyText?: string;
  findingSummary: string;
}): ReactionForInference {
  return {
    reactionId: reaction._id,
    findingId: reaction.findingId,
    kind: reaction.kind,
    ...(reaction.replyText === undefined ? {} : { replyText: reaction.replyText }),
    findingSummary: reaction.findingSummary,
    createdAt: reaction._creationTime,
  };
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

function buildDraftPrompt(input: {
  archetypeLabel: string;
  reactions: readonly ReactionForInference[];
}): string {
  const replyTexts = uniqueNonEmpty(input.reactions.map((reaction) => reaction.replyText)).slice(
    0,
    5,
  );
  const summaries = uniqueNonEmpty(
    input.reactions.map((reaction) => reaction.findingSummary),
  ).slice(0, 5);
  return [
    `Archetype: ${input.archetypeLabel}`,
    `Negative threshold: ${NEGATIVE_REACTION_THRESHOLD} weighted negative reactions.`,
    replyTexts.length === 0
      ? 'Reviewer replies: none.'
      : `Reviewer replies:\n${replyTexts.map((reply) => `- ${reply}`).join('\n')}`,
    summaries.length === 0
      ? 'Finding summaries: none.'
      : `Finding summaries:\n${summaries.map((summary) => `- ${summary}`).join('\n')}`,
    'Draft the SuggestedRule description for an operator deciding whether to suppress this archetype.',
  ].join('\n\n');
}

function fallbackDraftDescription(input: {
  archetypeLabel: string;
  reactions: readonly ReactionForInference[];
}): string {
  const replyTexts = uniqueNonEmpty(input.reactions.map((reaction) => reaction.replyText));
  const summaries = uniqueNonEmpty(input.reactions.map((reaction) => reaction.findingSummary));
  const seed = replyTexts[0] ?? summaries[0];
  if (seed === undefined) {
    return `Consider suppressing findings like "${input.archetypeLabel}" when reviewers mark them as unhelpful.`;
  }
  return `Consider suppressing findings like "${input.archetypeLabel}" when reviewer feedback says: ${seed}`;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function negativeWeightForKind(kind: ReactionKind): number {
  if (kind === '👎') {
    return 1;
  }
  if (kind === 'mergedIgnored') {
    return MERGED_IGNORED_NEGATIVE_WEIGHT;
  }
  return 0;
}

function totalWeightForKind(kind: ReactionKind): number {
  if (kind === 'reply') {
    return 0;
  }
  return 1;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), max));
}

function anthropicApiKeyFromEnv(): string | null {
  const apiKey = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.ANTHROPIC_API_KEY;
  return apiKey === undefined || apiKey.length === 0 ? null : apiKey;
}

function anthropicDraftModelFromEnv(): string {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.ANTHROPIC_SUGGESTED_RULE_MODEL ?? DEFAULT_ANTHROPIC_DRAFT_MODEL
  );
}

function globalFetch(input: string, init: Parameters<FetchLike>[1]): ReturnType<FetchLike> {
  return (globalThis as unknown as { fetch: FetchLike }).fetch(input, init);
}

function warn(message: string, error: unknown): void {
  (globalThis as { console?: { warn(message: string, error: unknown): void } }).console?.warn(
    message,
    error,
  );
}
