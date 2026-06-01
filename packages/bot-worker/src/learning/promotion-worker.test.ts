import { api } from '@sandy/convex-backend/api';
import { describe, expect, it } from 'vitest';
import { type PendingSuggestedRule, PromotionWorker } from './promotion-worker.js';

describe('PromotionWorker', () => {
  it('promotes suppression SuggestedRules by suppressing the source Archetype', async () => {
    const client = new FakePromotionConvexClient();
    const worker = new PromotionWorker({ client, logger: silentLogger });

    const stop = worker.start();
    client.emit([
      suggestedRule({
        _id: 'suggestedRules:1',
        status: 'promoteToSuppression',
        sourceArchetypeId: 'archetypes:1',
      }),
    ]);

    await tick();
    await tick();

    expect(client.subscription).toEqual({
      query: api.suggestedRules.subscribePending,
      args: {},
    });
    expect(client.mutations).toEqual([
      {
        mutation: api.archetypes.updateSuppressionWeight,
        args: { archetypeId: 'archetypes:1', suppressionWeight: 1 },
      },
      {
        mutation: api.suggestedRules.markPromoted,
        args: { suggestedRuleId: 'suggestedRules:1' },
      },
    ]);

    stop();
    expect(client.unsubscribed).toBe(true);
  });

  it('leaves rejected SuggestedRules untouched as history', async () => {
    const client = new FakePromotionConvexClient();
    const worker = new PromotionWorker({ client, logger: silentLogger });

    worker.start();
    client.emit([
      suggestedRule({
        _id: 'suggestedRules:1',
        status: 'rejected',
        sourceArchetypeId: 'archetypes:1',
      }),
    ]);

    await tick();

    expect(client.mutations).toEqual([]);
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

function suggestedRule(overrides: Partial<PendingSuggestedRule> = {}): PendingSuggestedRule {
  return {
    _id: 'suggestedRules:1',
    productId: 'products:1',
    type: 'suppression',
    status: 'promoteToSuppression',
    description: 'Suppress duplicate test-coverage findings.',
    sourceArchetypeId: 'archetypes:1',
    evidence: '{}',
    _creationTime: 1234,
    ...overrides,
  };
}

class FakePromotionConvexClient {
  mutations: { mutation: unknown; args: Record<string, unknown> }[] = [];
  subscription: { query: unknown; args: Record<string, never> } | null = null;
  unsubscribed = false;
  #callback: ((rules: PendingSuggestedRule[]) => void) | null = null;

  onUpdate(
    query: unknown,
    args: Record<string, never>,
    callback: (rules: PendingSuggestedRule[]) => void,
  ): { unsubscribe: () => void } {
    this.subscription = { query, args };
    this.#callback = callback;
    return {
      unsubscribe: () => {
        this.unsubscribed = true;
      },
    };
  }

  async mutation(mutation: unknown, args: Record<string, unknown>): Promise<null> {
    this.mutations.push({ mutation, args });
    return null;
  }

  emit(rules: PendingSuggestedRule[]): void {
    this.#callback?.(rules);
  }
}
