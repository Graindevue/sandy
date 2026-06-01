import { api } from '@sandy/convex-backend/api';
import type { FunctionReference } from 'convex/server';
import type { EnqueueInput, UpsertPullRequestInput } from '../webhook/sink.js';

type QueryRef = FunctionReference<'query'>;
type MutationRef = FunctionReference<'mutation'>;

export interface PendingSuppressionPromotion {
  _id: string;
}

export interface PromotionRepo {
  _id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface PromotionExemplar {
  findingId?: string;
  summary: string;
  evidence: string;
  category?: string;
  anchor: {
    repo: string;
    path: string;
    lineStart: number;
    lineEnd: number;
  };
}

export interface PendingPositivePromotion {
  _id: string;
  description: string;
  archetypeLabel: string;
  targetRepo: PromotionRepo;
  exemplars: PromotionExemplar[];
}

export interface PromotionWorkerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface PromotionWorkerConvexClient {
  onUpdate(
    query: QueryRef,
    args: Record<string, never>,
    callback: (rules: PendingSuppressionPromotion[] | PendingPositivePromotion[]) => void,
    onError?: (error: Error) => void,
  ): { unsubscribe: () => void } | (() => void);
  mutation(mutation: MutationRef, args: Record<string, unknown>): Promise<unknown>;
}

export interface ProductRulesPullRequest {
  number: number;
  draft: boolean;
  headSha: string;
  baseRef: string;
  title: string;
  author: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
}

export interface ProductRulesPullRequestInput {
  repo: {
    owner: string;
    name: string;
    defaultBranch: string;
  };
  suggestedRuleId: string;
  ruleLine: string;
}

export interface ProductRuleGitHub {
  openProductRulesPullRequest(
    input: ProductRulesPullRequestInput,
  ): Promise<ProductRulesPullRequest>;
}

export interface PromotionReviewSink {
  upsertPullRequest(input: UpsertPullRequestInput): Promise<string>;
  setReviewActive(pullRequestId: string, active: boolean): Promise<void>;
  enqueueReviewJob(input: EnqueueInput): Promise<string>;
}

export type ProductRuleLineDrafter = (promotion: PendingPositivePromotion) => Promise<string>;

export interface PromotionWorkerOptions {
  client: PromotionWorkerConvexClient;
  github?: ProductRuleGitHub;
  reviewSink?: PromotionReviewSink;
  resolveAgentKeys?: (repo: PromotionRepo) => readonly string[];
  draftRuleLine?: ProductRuleLineDrafter;
  logger?: PromotionWorkerLogger;
}

const defaultLogger: PromotionWorkerLogger = console;
const DEFAULT_AGENT_KEYS = ['logic'] as const;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_ANTHROPIC_PRODUCT_RULE_MODEL = 'claude-3-5-haiku-latest';

export class PromotionWorker {
  readonly #client: PromotionWorkerConvexClient;
  readonly #github: ProductRuleGitHub | null;
  readonly #reviewSink: PromotionReviewSink | null;
  readonly #resolveAgentKeys: (repo: PromotionRepo) => readonly string[];
  readonly #draftRuleLine: ProductRuleLineDrafter;
  readonly #logger: PromotionWorkerLogger;
  readonly #inFlight = new Set<string>();

  constructor(options: PromotionWorkerOptions) {
    this.#client = options.client;
    this.#github = options.github ?? null;
    this.#reviewSink = options.reviewSink ?? null;
    this.#resolveAgentKeys = options.resolveAgentKeys ?? (() => DEFAULT_AGENT_KEYS);
    this.#draftRuleLine = options.draftRuleLine ?? draftProductRuleLine;
    this.#logger = options.logger ?? defaultLogger;
  }

  start(): () => void {
    const subscriptions = [
      this.#client.onUpdate(
        api.suggestedRules.subscribeSuppressionPromotions,
        {},
        (rules) => {
          for (const rule of rules as PendingSuppressionPromotion[]) {
            void this.#promoteSuppression(rule);
          }
        },
        (error) => {
          this.#logger.error('suggestedRules.subscribeSuppressionPromotions failed', error);
        },
      ),
      this.#client.onUpdate(
        api.suggestedRules.subscribePositivePromotions,
        {},
        (rules) => {
          for (const rule of rules as PendingPositivePromotion[]) {
            void this.#promotePositive(rule);
          }
        },
        (error) => {
          this.#logger.error('suggestedRules.subscribePositivePromotions failed', error);
        },
      ),
    ];

    return () => {
      for (const subscription of subscriptions) {
        if (typeof subscription === 'function') {
          subscription();
        } else {
          subscription.unsubscribe();
        }
      }
    };
  }

  async #promoteSuppression(rule: PendingSuppressionPromotion): Promise<void> {
    if (this.#inFlight.has(rule._id)) {
      return;
    }

    this.#inFlight.add(rule._id);
    try {
      const promoted = await this.#client.mutation(api.suggestedRules.promoteSuppression, {
        suggestedRuleId: rule._id,
      });
      if (promoted === true) {
        this.#logger.info(`Promoted SuggestedRule ${rule._id} to suppression`);
      }
    } catch (error) {
      this.#logger.error(`Failed to promote SuggestedRule ${rule._id}`, error);
    } finally {
      this.#inFlight.delete(rule._id);
    }
  }

  async #promotePositive(rule: PendingPositivePromotion): Promise<void> {
    if (this.#inFlight.has(rule._id)) {
      return;
    }
    if (this.#github === null || this.#reviewSink === null) {
      this.#logger.error(
        `Failed to promote SuggestedRule ${rule._id}`,
        new Error('positive promotion requires github and reviewSink options'),
      );
      return;
    }

    this.#inFlight.add(rule._id);
    try {
      const ruleLine = normalizeRuleLine(await this.#draftRuleLine(rule), rule);
      const pullRequest = await this.#github.openProductRulesPullRequest({
        repo: {
          owner: rule.targetRepo.owner,
          name: rule.targetRepo.name,
          defaultBranch: rule.targetRepo.defaultBranch,
        },
        suggestedRuleId: rule._id,
        ruleLine,
      });
      const pullRequestId = await this.#reviewSink.upsertPullRequest({
        repoId: rule.targetRepo._id,
        number: pullRequest.number,
        state: pullRequest.state,
        draft: pullRequest.draft,
        headSha: pullRequest.headSha,
        baseRef: pullRequest.baseRef,
        title: pullRequest.title,
        author: pullRequest.author,
        url: pullRequest.url,
      });
      await this.#reviewSink.setReviewActive(pullRequestId, true);
      await this.#reviewSink.enqueueReviewJob({
        pullRequestId,
        repoId: rule.targetRepo._id,
        headSha: pullRequest.headSha,
        trigger: 'opened',
        agentKeys: [...this.#resolveAgentKeys(rule.targetRepo)],
      });
      const markedPromoted = await this.#client.mutation(api.suggestedRules.markPromoted, {
        suggestedRuleId: rule._id,
        expectedStatus: 'promoteToPositive',
      });
      if (markedPromoted !== true) {
        this.#logger.warn(
          `Skipped marking SuggestedRule ${rule._id} promoted because its status changed`,
        );
        return;
      }
      this.#logger.info(
        `Promoted SuggestedRule ${rule._id} to product rule PR ${rule.targetRepo.fullName}#${pullRequest.number}`,
      );
    } catch (error) {
      this.#logger.error(`Failed to promote SuggestedRule ${rule._id}`, error);
    } finally {
      this.#inFlight.delete(rule._id);
    }
  }
}

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

function fallbackProductRuleLine(promotion: PendingPositivePromotion): string {
  const seed = firstNonEmpty([
    promotion.exemplars[0]?.summary,
    promotion.exemplars[0]?.evidence,
    promotion.description,
    promotion.archetypeLabel,
  ]);
  return `- Check ${promotion.archetypeLabel} patterns before approving changes: ${seed}`;
}

function normalizeRuleLine(raw: string, promotion: PendingPositivePromotion): string {
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
