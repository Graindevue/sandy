import { api } from '@sandy/convex-backend/api';
import { describe, expect, it } from 'vitest';
import { type PendingSuppressionPromotion, PromotionWorker } from './promotion-worker.js';

describe('PromotionWorker', () => {
  it('promotes suppression SuggestedRules by suppressing the source Archetype', async () => {
    const client = new FakePromotionConvexClient();
    const worker = new PromotionWorker({ client, logger: silentLogger });

    const stop = worker.start();
    client.emit([{ _id: 'suggestedRules:1' }]);

    await tick();

    expect(client.subscription).toEqual({
      query: api.suggestedRules.subscribeSuppressionPromotions,
      args: {},
    });
    expect(client.mutations).toEqual([
      {
        mutation: api.suggestedRules.promoteSuppression,
        args: { suggestedRuleId: 'suggestedRules:1' },
      },
    ]);

    stop();
    expect(client.unsubscribed).toBe(true);
  });

  it('does not promote the same SuggestedRule twice while promotion is in flight', async () => {
    const client = new FakePromotionConvexClient({ resolveMutations: false });
    const worker = new PromotionWorker({ client, logger: silentLogger });

    worker.start();
    client.emit([{ _id: 'suggestedRules:1' }]);
    client.emit([{ _id: 'suggestedRules:1' }]);

    await tick();

    expect(client.mutations).toEqual([
      {
        mutation: api.suggestedRules.promoteSuppression,
        args: { suggestedRuleId: 'suggestedRules:1' },
      },
    ]);
  });
});

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakePromotionConvexClient {
  mutations: { mutation: unknown; args: Record<string, unknown> }[] = [];
  subscription: { query: unknown; args: Record<string, never> } | null = null;
  unsubscribed = false;
  #callback: ((rules: PendingSuppressionPromotion[]) => void) | null = null;
  readonly #resolveMutations: boolean;

  constructor({ resolveMutations = true }: { resolveMutations?: boolean } = {}) {
    this.#resolveMutations = resolveMutations;
  }

  onUpdate(
    query: unknown,
    args: Record<string, never>,
    callback: (rules: PendingSuppressionPromotion[]) => void,
  ): { unsubscribe: () => void } {
    this.subscription = { query, args };
    this.#callback = callback;
    return {
      unsubscribe: () => {
        this.unsubscribed = true;
      },
    };
  }

  async mutation(mutation: unknown, args: Record<string, unknown>): Promise<boolean> {
    this.mutations.push({ mutation, args });
    if (!this.#resolveMutations) {
      await new Promise<never>(() => undefined);
    }
    return true;
  }

  emit(rules: PendingSuppressionPromotion[]): void {
    this.#callback?.(rules);
  }
}
