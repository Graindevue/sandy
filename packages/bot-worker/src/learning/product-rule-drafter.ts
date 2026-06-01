import type { PendingPositivePromotion, PromotionExemplar } from './promotion-types.js';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_ANTHROPIC_PRODUCT_RULE_MODEL = 'claude-3-5-haiku-latest';

export type ProductRuleLineDrafter = (promotion: PendingPositivePromotion) => Promise<string>;

export async function draftProductRuleLine(promotion: PendingPositivePromotion): Promise<string> {
  const fallback = fallbackProductRuleLine(promotion);
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
        model: anthropicProductRuleModelFromEnv(),
        max_tokens: 180,
        temperature: 0.2,
        system:
          'Draft product-level code-review rules from recurring Sandy Finding exemplars. Return one Markdown bullet line only.',
        messages: [
          {
            role: 'user',
            content: buildProductRulePrompt(promotion),
          },
        ],
      }),
    });
    if (!response.ok) {
      warn(
        `Anthropic product Rule draft request failed with ${response.status}`,
        await response.text(),
      );
      return fallback;
    }

    const body = (await response.json()) as AnthropicMessageResponse;
    const text = firstAnthropicText(body)?.trim();
    return text === undefined || text.length === 0 ? fallback : text;
  } catch (error) {
    warn('Anthropic product Rule draft request failed', error);
    return fallback;
  }
}

export function normalizeProductRuleLine(raw: string, promotion: PendingPositivePromotion): string {
  const compact = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const line = compact.length === 0 ? fallbackProductRuleLine(promotion) : compact;
  return /^[-*]\s+/.test(line) ? `- ${line.replace(/^[-*]\s+/, '')}` : `- ${line}`;
}

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

function fallbackProductRuleLine(promotion: PendingPositivePromotion): string {
  const seed = firstNonEmpty([
    promotion.exemplars[0]?.summary,
    promotion.exemplars[0]?.evidence,
    promotion.description,
    promotion.archetypeLabel,
  ]);
  return `- Check ${promotion.archetypeLabel} patterns before approving changes: ${seed}`;
}

function buildProductRulePrompt(promotion: PendingPositivePromotion): string {
  return [
    `SuggestedRule: ${promotion.description}`,
    `Archetype: ${promotion.archetypeLabel}`,
    `Target product-rules Repo: ${promotion.targetRepo.fullName}`,
    `Exemplars:\n${promotion.exemplars.map(formatExemplarForPrompt).join('\n')}`,
    'Draft one positive, actionable product Rule that would help reviewers catch this pattern in future PRs.',
  ].join('\n\n');
}

function formatExemplarForPrompt(exemplar: PromotionExemplar, index: number): string {
  return [
    `${index + 1}. ${exemplar.summary}`,
    `   Anchor: ${exemplar.anchor.repo}/${exemplar.anchor.path}:${exemplar.anchor.lineStart}`,
    `   Evidence: ${exemplar.evidence}`,
  ].join('\n');
}

function firstAnthropicText(body: AnthropicMessageResponse): string | undefined {
  for (const part of body.content ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') {
      return part.text;
    }
  }
  return undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  return 'reviewers have repeatedly confirmed this pattern matters';
}

function anthropicApiKeyFromEnv(): string | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey === undefined || apiKey.length === 0 ? null : apiKey;
}

function anthropicProductRuleModelFromEnv(): string {
  return (
    process.env.ANTHROPIC_PRODUCT_RULE_MODEL ??
    process.env.ANTHROPIC_SUGGESTED_RULE_MODEL ??
    DEFAULT_ANTHROPIC_PRODUCT_RULE_MODEL
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
