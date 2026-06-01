import { api } from '@sandy/convex-backend/api';
import type { SuggestedRuleStatus, SuggestedRuleType } from '@sandy/shared-types';

export interface PendingSuggestedRule {
  _id: string;
  _creationTime: number;
  productId: string;
  type: SuggestedRuleType;
  status: SuggestedRuleStatus;
  description: string;
  sourceArchetypeId: string;
  evidence: string;
}

export interface PromotionWorkerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface PromotionWorkerConvexClient {
  onUpdate(
    query: unknown,
    args: Record<string, never>,
    callback: (rules: PendingSuggestedRule[]) => void,
    onError?: (error: Error) => void,
  ): { unsubscribe: () => void } | (() => void);
  mutation(mutation: unknown, args: Record<string, unknown>): Promise<unknown>;
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
      api.suggestedRules.subscribePending,
      {},
      (rules) => {
        for (const rule of rules) {
          void this.#promote(rule);
        }
      },
      (error) => {
        this.#logger.error('suggestedRules.subscribePending failed', error);
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

  async #promote(rule: PendingSuggestedRule): Promise<void> {
    if (this.#inFlight.has(rule._id)) {
      return;
    }
    if (rule.status !== 'promoteToSuppression') {
      return;
    }

    this.#inFlight.add(rule._id);
    try {
      await this.#client.mutation(api.archetypes.updateSuppressionWeight, {
        archetypeId: rule.sourceArchetypeId,
        suppressionWeight: 1,
      });
      await this.#client.mutation(api.suggestedRules.markPromoted, {
        suggestedRuleId: rule._id,
      });
      this.#logger.info(`Promoted SuggestedRule ${rule._id} to suppression`);
    } catch (error) {
      this.#logger.error(`Failed to promote SuggestedRule ${rule._id}`, error);
    } finally {
      this.#inFlight.delete(rule._id);
    }
  }
}
