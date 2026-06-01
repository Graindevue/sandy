import { api } from '@sandy/convex-backend/api';
import { describe, expect, it } from 'vitest';
import {
  type PendingPositivePromotion,
  type PendingSuppressionPromotion,
  PromotionWorker,
} from './promotion-worker.js';

describe('PromotionWorker', () => {
  it('promotes suppression SuggestedRules by suppressing the source Archetype', async () => {
    const client = new FakePromotionConvexClient();
    const worker = new PromotionWorker({ client, logger: silentLogger });

    const stop = worker.start();
    client.emit([{ _id: 'suggestedRules:1' }]);

    await tick();

    expect(client.subscriptions[0]).toEqual({
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
    expect(client.unsubscribedCount).toBe(2);
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

  it('opens and opts in a product-rules PR for positive SuggestedRules', async () => {
    const client = new FakePromotionConvexClient();
    const github = new FakeProductRuleGitHub();
    const sink = new FakePromotionReviewSink();
    const drafts: PendingPositivePromotion[] = [];
    const worker = new PromotionWorker({
      client,
      github,
      reviewSink: sink,
      resolveAgentKeys: () => ['logic', 'security'],
      draftRuleLine: async (promotion) => {
        drafts.push(promotion);
        return '- Keep tenant cache keys stable when cached data crosses account boundaries.';
      },
      logger: silentLogger,
    });

    worker.start();
    client.emitPositive([
      {
        _id: 'suggestedRules:2',
        description: 'Cache findings keep catching tenant-unsafe cache keys.',
        archetypeLabel: 'Tenant cache key drift',
        targetRepo: {
          _id: 'repos:1',
          owner: 'acme',
          name: 'api',
          fullName: 'acme/api',
          defaultBranch: 'main',
        },
        exemplars: [
          {
            summary: 'The cache key omits tenantId.',
            evidence: 'getCachedAccount(accountId) shares data across tenants.',
            anchor: {
              repo: 'acme/api',
              path: 'src/cache.ts',
              lineStart: 12,
              lineEnd: 12,
            },
          },
        ],
      },
    ]);

    await tick();

    expect(drafts).toHaveLength(1);
    expect(github.opened).toEqual([
      {
        repo: { owner: 'acme', name: 'api', defaultBranch: 'main' },
        suggestedRuleId: 'suggestedRules:2',
        ruleLine: '- Keep tenant cache keys stable when cached data crosses account boundaries.',
      },
    ]);
    expect(sink.upserts).toEqual([
      {
        repoId: 'repos:1',
        number: 45,
        state: 'open',
        draft: false,
        headSha: 'promotion-sha',
        baseRef: 'main',
        title: 'Add product rule from SuggestedRule suggestedRules:2',
        author: 'sandy[bot]',
        url: 'https://github.com/acme/api/pull/45',
      },
    ]);
    expect(sink.reviewActive).toEqual([{ pullRequestId: 'pullRequests:1', active: true }]);
    expect(sink.enqueued).toEqual([
      {
        pullRequestId: 'pullRequests:1',
        repoId: 'repos:1',
        headSha: 'promotion-sha',
        trigger: 'opened',
        agentKeys: ['logic', 'security'],
      },
    ]);
    expect(client.mutations).toEqual([
      {
        mutation: api.suggestedRules.markPromoted,
        args: {
          suggestedRuleId: 'suggestedRules:2',
          expectedStatus: 'promoteToPositive',
        },
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
  subscriptions: { query: unknown; args: Record<string, never> }[] = [];
  unsubscribedCount = 0;
  #suppressionCallback: ((rules: PendingSuppressionPromotion[]) => void) | null = null;
  #positiveCallback: ((rules: PendingPositivePromotion[]) => void) | null = null;
  readonly #resolveMutations: boolean;

  constructor({ resolveMutations = true }: { resolveMutations?: boolean } = {}) {
    this.#resolveMutations = resolveMutations;
  }

  onUpdate(
    query: unknown,
    args: Record<string, never>,
    callback: (rules: PendingSuppressionPromotion[] | PendingPositivePromotion[]) => void,
  ): { unsubscribe: () => void } {
    this.subscriptions.push({ query, args });
    if (this.subscriptions.length === 1) {
      this.#suppressionCallback = callback as (rules: PendingSuppressionPromotion[]) => void;
    } else {
      this.#positiveCallback = callback as (rules: PendingPositivePromotion[]) => void;
    }
    return {
      unsubscribe: () => {
        this.unsubscribedCount += 1;
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
    this.#suppressionCallback?.(rules);
  }

  emitPositive(rules: PendingPositivePromotion[]): void {
    this.#positiveCallback?.(rules);
  }
}

class FakeProductRuleGitHub {
  opened: Array<{
    repo: { owner: string; name: string; defaultBranch: string };
    suggestedRuleId: string;
    ruleLine: string;
  }> = [];

  async openProductRulesPullRequest(input: {
    repo: { owner: string; name: string; defaultBranch: string };
    suggestedRuleId: string;
    ruleLine: string;
  }) {
    this.opened.push(input);
    return {
      number: 45,
      draft: false,
      headSha: 'promotion-sha',
      baseRef: input.repo.defaultBranch,
      title: `Add product rule from SuggestedRule ${input.suggestedRuleId}`,
      author: 'sandy[bot]',
      url: `https://github.com/${input.repo.owner}/${input.repo.name}/pull/45`,
      state: 'open' as const,
      headRepo: { owner: input.repo.owner, name: input.repo.name },
    };
  }
}

class FakePromotionReviewSink {
  upserts: Array<Record<string, unknown>> = [];
  reviewActive: Array<{ pullRequestId: string; active: boolean }> = [];
  enqueued: Array<Record<string, unknown>> = [];

  async upsertPullRequest(input: Record<string, unknown>): Promise<string> {
    this.upserts.push(input);
    return 'pullRequests:1';
  }

  async setReviewActive(pullRequestId: string, active: boolean): Promise<void> {
    this.reviewActive.push({ pullRequestId, active });
  }

  async enqueueReviewJob(input: Record<string, unknown>): Promise<string> {
    this.enqueued.push(input);
    return 'reviewJobs:1';
  }
}
