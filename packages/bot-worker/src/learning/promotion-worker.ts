import { api } from '@sandy/convex-backend/api';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { PositivePromotionPromoter } from './positive-promotion.js';
import { draftProductRuleLine, type ProductRuleLineDrafter } from './product-rule-drafter.js';
import type {
  PendingPositivePromotion,
  PendingSuppressionPromotion,
  PositivePromotionStore,
  ProductRuleGitHub,
  PromotionRepo,
  PromotionWorkerLogger,
} from './promotion-types.js';

export { draftProductRuleLine } from './product-rule-drafter.js';
export type {
  PendingPositivePromotion,
  PendingSuppressionPromotion,
  PromotionRepo,
  PromotionWorkerLogger,
} from './promotion-types.js';

type Subscription = { unsubscribe: () => void } | (() => void);

export interface PromotionWorkerConvexClient {
  onUpdate<Query extends FunctionReference<'query'>>(
    query: Query,
    args: FunctionArgs<Query>,
    callback: (rules: FunctionReturnType<Query>) => void,
    onError?: (error: Error) => void,
  ): Subscription;
  mutation<Mutation extends FunctionReference<'mutation'>>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ): Promise<FunctionReturnType<Mutation>>;
}

export interface PromotionWorkerOptions {
  client: PromotionWorkerConvexClient;
  github?: ProductRuleGitHub;
  reviewSink?: PositivePromotionStore;
  resolveAgentKeys?: (repo: PromotionRepo) => readonly string[];
  draftRuleLine?: ProductRuleLineDrafter;
  logger?: PromotionWorkerLogger;
}

const defaultLogger: PromotionWorkerLogger = console;
const DEFAULT_AGENT_KEYS = ['logic'] as const;

export class PromotionWorker {
  readonly #client: PromotionWorkerConvexClient;
  readonly #positivePromoter: PositivePromotionPromoter | null;
  readonly #logger: PromotionWorkerLogger;
  readonly #inFlight = new Set<string>();

  constructor(options: PromotionWorkerOptions) {
    this.#client = options.client;
    this.#logger = options.logger ?? defaultLogger;
    const resolveAgentKeys = options.resolveAgentKeys ?? (() => DEFAULT_AGENT_KEYS);
    const draftRuleLine = options.draftRuleLine ?? draftProductRuleLine;
    this.#positivePromoter =
      options.github === undefined || options.reviewSink === undefined
        ? null
        : new PositivePromotionPromoter({
            github: options.github,
            store: options.reviewSink,
            resolveAgentKeys,
            draftRuleLine,
            logger: this.#logger,
          });
  }

  start(): () => void {
    const subscriptions: Subscription[] = [
      this.#client.onUpdate(
        api.suggestedRules.subscribeSuppressionPromotions,
        {},
        (rules) => {
          for (const rule of rules) {
            this.#scheduleSuppressionPromotion(rule);
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
          for (const rule of rules) {
            this.#schedulePositivePromotion(rule);
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

  #scheduleSuppressionPromotion(rule: PendingSuppressionPromotion): void {
    this.#promoteOnce(rule._id, async () => {
      const promoted = await this.#client.mutation(api.suggestedRules.promoteSuppression, {
        suggestedRuleId: rule._id as never,
      });
      if (promoted === true) {
        this.#logger.info(`Promoted SuggestedRule ${rule._id} to suppression`);
      }
    });
  }

  #schedulePositivePromotion(rule: PendingPositivePromotion): void {
    const promoter = this.#positivePromoter;
    if (promoter === null) {
      this.#logger.error(
        `Failed to promote SuggestedRule ${rule._id}`,
        new Error('positive promotion requires github and reviewSink options'),
      );
      return;
    }
    this.#promoteOnce(rule._id, () => promoter.promote(rule));
  }

  #promoteOnce(ruleId: string, promote: () => Promise<void>): void {
    if (this.#inFlight.has(ruleId)) {
      return;
    }
    this.#inFlight.add(ruleId);
    void this.#runPromotion(ruleId, promote);
  }

  async #runPromotion(ruleId: string, promote: () => Promise<void>): Promise<void> {
    try {
      await promote();
    } catch (error) {
      this.#logger.error(`Failed to promote SuggestedRule ${ruleId}`, error);
    } finally {
      this.#inFlight.delete(ruleId);
    }
  }
}
