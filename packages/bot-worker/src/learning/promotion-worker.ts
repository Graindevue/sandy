import { api } from '@sandy/convex-backend/api';
import type { FunctionReference } from 'convex/server';

type QueryRef = FunctionReference<'query'>;
type MutationRef = FunctionReference<'mutation'>;

export interface PendingSuppressionPromotion {
  _id: string;
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
    callback: (rules: PendingSuppressionPromotion[]) => void,
    onError?: (error: Error) => void,
  ): { unsubscribe: () => void } | (() => void);
  mutation(mutation: MutationRef, args: Record<string, unknown>): Promise<unknown>;
}

export interface PromotionWorkerOptions {
  client: PromotionWorkerConvexClient;
  logger?: PromotionWorkerLogger;
}

const defaultLogger: PromotionWorkerLogger = console;

export class PromotionWorker {
  readonly #client: PromotionWorkerConvexClient;
  readonly #logger: PromotionWorkerLogger;
  readonly #inFlight = new Set<string>();

  constructor(options: PromotionWorkerOptions) {
    this.#client = options.client;
    this.#logger = options.logger ?? defaultLogger;
  }

  start(): () => void {
    const subscription = this.#client.onUpdate(
      api.suggestedRules.subscribeSuppressionPromotions,
      {},
      (rules) => {
        for (const rule of rules) {
          void this.#promote(rule);
        }
      },
      (error) => {
        this.#logger.error('suggestedRules.subscribeSuppressionPromotions failed', error);
      },
    );

    return () => {
      if (typeof subscription === 'function') {
        subscription();
      } else {
        subscription.unsubscribe();
      }
    };
  }

  async #promote(rule: PendingSuppressionPromotion): Promise<void> {
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
}
