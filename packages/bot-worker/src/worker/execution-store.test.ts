import type { Finding } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import { type ConvexExecutionClient, ConvexExecutionStore } from './execution-store.js';

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

  it('records synthesized Review confidence and Findings atomically', async () => {
    const client = new FakeConvexClient();
    const store = new ConvexExecutionStore(client);

    const persisted = await store.recordSynthesizedReview({
      reviewJobId: 'job-1',
      pullRequestId: 'pr-1',
      confidenceScore: 4,
      findings: [finding],
    });

    expect(client.mutations[0]?.args).toEqual({
      reviewJobId: 'job-1',
      pullRequestId: 'pr-1',
      confidenceScore: 4,
      findings: [
        {
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
        },
      ],
    });
    expect(persisted).toEqual([{ id: 'finding-1', finding }]);
  });

  it('records a finding with anchor and cross-repo references intact', async () => {
    const client = new FakeConvexClient();
    const store = new ConvexExecutionStore(client);

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

  it('records an Agent run with Cross-Repo Search rationale', async () => {
    const client = new FakeConvexClient();
    const store = new ConvexExecutionStore(client);

    await store.recordAgentRun({
      reviewJobId: 'job-1',
      agentKey: 'logic',
      status: 'completed',
      startedAt: 100,
      finishedAt: 200,
      findingCount: 0,
      crossRepoSearch: {
        status: 'skipped',
        trigger: 'none',
        rationale: 'Only CSS changed; no cross-repo contract risk was detected.',
      },
    });

    expect(client.mutations[0]?.args).toEqual({
      reviewJobId: 'job-1',
      agentKey: 'logic',
      status: 'completed',
      startedAt: 100,
      finishedAt: 200,
      findingCount: 0,
      crossRepoSearch: {
        status: 'skipped',
        trigger: 'none',
        rationale: 'Only CSS changed; no cross-repo contract risk was detected.',
      },
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
    if (Array.isArray(args.findings)) {
      return args.findings.map((_finding, index) => `finding-${index + 1}`);
    }
    return 'finding-1';
  }
}
