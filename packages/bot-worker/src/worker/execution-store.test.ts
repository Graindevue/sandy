import type { Finding } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import { type ConvexExecutionClient, ConvexExecutionStore } from './execution-store.js';

describe('ConvexExecutionStore', () => {
  it('records sibling SHAs on the ReviewJob', async () => {
    const client = new FakeConvexClient();
    const store = new ConvexExecutionStore(client);

    await store.recordSiblingShas('job-1', { 'acme/desktop': 'desktop-main-sha' });

    expect(client.mutations[0]?.args).toEqual({
      jobId: 'job-1',
      siblingShas: { 'acme/desktop': 'desktop-main-sha' },
    });
  });

  it('records a finding with anchor and cross-repo references intact', async () => {
    const client = new FakeConvexClient();
    const store = new ConvexExecutionStore(client);
    const finding: Finding = {
      severity: 'P1',
      confidence: 4,
      agentKey: 'logic',
      anchor: {
        repo: 'acme/widget',
        path: 'src/cache.ts',
        lineStart: 22,
        lineEnd: 24,
      },
      crossRepoReferences: [
        {
          repo: 'acme/consumer',
          path: 'src/orders.ts',
          line: 31,
        },
      ],
      summary: 'The cache key ignores the tenant id.',
      evidence: 'The lookup only uses userId, so two tenants can collide.',
      suggestedFix: 'Include tenantId in the key.',
      category: 'logic',
    };

    await store.recordFinding({
      reviewJobId: 'job-1',
      pullRequestId: 'pr-1',
      finding,
    });

    expect(client.mutations[0]?.args).toEqual({
      reviewJobId: 'job-1',
      pullRequestId: 'pr-1',
      agentKey: 'logic',
      severity: 'P1',
      confidence: 4,
      anchor: {
        repo: 'acme/widget',
        path: 'src/cache.ts',
        lineStart: 22,
        lineEnd: 24,
      },
      crossRepoReferences: [{ repo: 'acme/consumer', path: 'src/orders.ts', line: 31 }],
      summary: 'The cache key ignores the tenant id.',
      evidence: 'The lookup only uses userId, so two tenants can collide.',
      suggestedFix: 'Include tenantId in the key.',
      category: 'logic',
    });
  });
});

class FakeConvexClient implements ConvexExecutionClient {
  readonly queries: Array<{ args: Record<string, unknown> }> = [];
  readonly mutations: Array<{ args: Record<string, unknown> }> = [];

  async query(
    _query: Parameters<ConvexExecutionClient['query']>[0],
    args: Record<string, unknown>,
  ) {
    this.queries.push({ args });
    return null;
  }

  async mutation(
    _mutation: Parameters<ConvexExecutionClient['mutation']>[0],
    args: Record<string, unknown>,
  ) {
    this.mutations.push({ args });
    return 'finding-1';
  }
}
