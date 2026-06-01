import type { ReactionKind } from '@sandy/shared-types';
import type { RecentArchetypeReaction } from './reactionEvidence.js';

export const NEGATIVE_REACTION_THRESHOLD = 3;

const MERGED_IGNORED_NEGATIVE_WEIGHT = 1 / 3;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_ANTHROPIC_DRAFT_MODEL = 'claude-3-5-haiku-latest';

export type ReactionForInference = {
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

export type ReactionEvidenceScore = {
  negativeScore: number;
  totalScore: number;
  suppressionWeight: number;
  supportingReactions: SupportingReaction[];
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

export function reactionForInference(reaction: RecentArchetypeReaction): ReactionForInference {
  return {
    reactionId: reaction._id,
    findingId: reaction.findingId,
    kind: reaction.kind,
    ...(reaction.replyText === undefined ? {} : { replyText: reaction.replyText }),
    findingSummary: reaction.findingSummary,
    createdAt: reaction._creationTime,
  };
}

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

export function evidenceMeetsSuggestedRuleThreshold(score: ReactionEvidenceScore): boolean {
  return score.negativeScore >= NEGATIVE_REACTION_THRESHOLD;
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

export function fallbackDraftDescription(input: {
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

function firstAnthropicText(body: AnthropicMessageResponse): string | undefined {
  for (const part of body.content ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') {
      return part.text;
    }
  }
  return undefined;
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
