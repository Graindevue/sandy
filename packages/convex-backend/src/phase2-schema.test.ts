import { describe, expect, it } from 'vitest';
import { record as recordAgentRun } from '../convex/agentRuns.js';
import { listForPr, recordFinding, recordSynthesizedReview } from '../convex/findings.js';
import {
  clearOnClose,
  listMergedForMergeStateBackfill,
  markMergeStateSignalsRolledUp,
} from '../convex/pullRequests.js';
import { recordMergeStateReaction } from '../convex/reactions.js';
import { enqueue, setConfidenceScore, setSiblingShas } from '../convex/reviewJobs.js';

describe('Phase 2 Convex schema handlers', () => {
  it('round-trips anchor-only and cross-repo Findings', async () => {
    const ctx = fakeCtx();

    const anchorOnlyId = await invoke(recordFinding, ctx, {
      reviewJobId: 'reviewJobs:1',
      pullRequestId: 'pullRequests:1',
      agentKey: 'logic',
      severity: 'P2',
      confidence: 3,
      anchor: {
        repo: 'acme/widget',
        path: 'src/cache.ts',
        lineStart: 12,
        lineEnd: 12,
      },
      summary: 'The cache branch has no regression test.',
      evidence: 'No test covers tenant cache keys.',
      category: 'test-coverage',
    });

    const crossRepoId = await invoke(recordFinding, ctx, {
      reviewJobId: 'reviewJobs:1',
      pullRequestId: 'pullRequests:1',
      agentKey: 'logic',
      severity: 'P1',
      confidence: 4,
      anchor: {
        repo: 'acme/widget',
        path: 'src/api.ts',
        lineStart: 22,
        lineEnd: 24,
      },
      crossRepoReferences: [{ repo: 'acme/consumer', path: 'src/orders.ts', line: 31 }],
      summary: 'Renaming the query breaks the consumer.',
      evidence: 'The sibling app still calls api.orders.getActiveOrders.',
      suggestedFix: 'Keep an alias or update the consumer.',
      category: 'convex',
    });

    const findings = await invoke(listForPr, ctx, { pullRequestId: 'pullRequests:1' });

    expect(anchorOnlyId).toBe('findings:1');
    expect(crossRepoId).toBe('findings:2');
    expect(findings).toEqual([
      expect.objectContaining({
        _id: 'findings:2',
        anchor: { repo: 'acme/widget', path: 'src/api.ts', lineStart: 22, lineEnd: 24 },
        crossRepoReferences: [{ repo: 'acme/consumer', path: 'src/orders.ts', line: 31 }],
      }),
      expect.objectContaining({
        _id: 'findings:1',
        anchor: { repo: 'acme/widget', path: 'src/cache.ts', lineStart: 12, lineEnd: 12 },
      }),
    ]);
    expect(findings[1]).not.toHaveProperty('crossRepoReferences');
  });

  it('records synthesized Review confidence and Findings in one mutation', async () => {
    const ctx = fakeCtx();
    const reviewJobId = await invoke(enqueue, ctx, {
      pullRequestId: 'pullRequests:1',
      repoId: 'repos:1',
      headSha: 'head-sha',
      trigger: 'mention',
      agentKeys: ['logic'],
    });

    const findingIds = await invoke(recordSynthesizedReview, ctx, {
      reviewJobId,
      pullRequestId: 'pullRequests:1',
      confidenceScore: 5,
      findings: [
        {
          agentKey: 'logic',
          severity: 'P0',
          confidence: 5,
          anchor: {
            repo: 'acme/widget',
            path: 'src/cache.ts',
            lineStart: 12,
            lineEnd: 12,
          },
          summary: 'The cache key ignores the tenant id.',
          evidence: 'The lookup only uses userId.',
          category: 'logic',
        },
      ],
    });

    expect(findingIds).toEqual(['findings:1']);
    expect(ctx.db.getDoc(reviewJobId)).toEqual(expect.objectContaining({ confidenceScore: 5 }));
    expect(await invoke(listForPr, ctx, { pullRequestId: 'pullRequests:1' })).toEqual([
      expect.objectContaining({
        _id: 'findings:1',
        reviewJobId,
        summary: 'The cache key ignores the tenant id.',
      }),
    ]);
  });

  it('persists review job confidence, agent run references, and sibling SHAs', async () => {
    const ctx = fakeCtx();

    const reviewJobId = await invoke(enqueue, ctx, {
      pullRequestId: 'pullRequests:1',
      repoId: 'repos:1',
      headSha: 'head-sha',
      trigger: 'mention',
      agentKeys: ['logic', 'convex'],
      siblingShas: { 'acme/consumer': 'consumer-main-sha' },
    });
    await invoke(setConfidenceScore, ctx, { jobId: reviewJobId, confidenceScore: 4 });
    await invoke(setSiblingShas, ctx, {
      jobId: reviewJobId,
      siblingShas: { 'acme/consumer': 'consumer-main-sha-2' },
    });
    const agentRunId = await invoke(recordAgentRun, ctx, {
      reviewJobId,
      agentKey: 'logic',
      status: 'completed',
      startedAt: 100,
      finishedAt: 200,
      findingCount: 1,
      crossRepoSearch: {
        status: 'searched',
        trigger: 'manifest',
        rationale: 'A Manifest-listed Convex query changed, so sibling consumers were searched.',
        searchedRepos: ['acme/consumer'],
      },
    });

    expect(ctx.db.getDoc(reviewJobId)).toEqual(
      expect.objectContaining({
        confidenceScore: 4,
        agentRuns: [agentRunId],
        siblingShas: { 'acme/consumer': 'consumer-main-sha-2' },
      }),
    );
    expect(ctx.db.getDoc(agentRunId)).toEqual(
      expect.objectContaining({
        crossRepoSearch: {
          status: 'searched',
          trigger: 'manifest',
          rationale: 'A Manifest-listed Convex query changed, so sibling consumers were searched.',
          searchedRepos: ['acme/consumer'],
        },
      }),
    );
  });

  it('clears reviewActive without clobbering a merged PR state', async () => {
    const ctx = fakeCtx();
    const pullRequestId = await ctx.db.insert('pullRequests', {
      repoId: 'repos:1',
      number: 12,
      state: 'merged',
      draft: false,
      headSha: 'head-sha',
      baseRef: 'main',
      title: 'PR',
      author: 'octocat',
      url: 'https://example.test/pr/12',
      reviewActive: true,
    });

    await invoke(clearOnClose, ctx, { pullRequestId });

    expect(ctx.db.getDoc(pullRequestId)).toEqual(
      expect.objectContaining({ state: 'merged', reviewActive: false }),
    );
  });

  it('records at most one merge-state reaction per Finding', async () => {
    const ctx = fakeCtx();
    await ctx.db.insert('reactions', { findingId: 'findings:1', kind: '👍' });

    await expect(
      invoke(recordMergeStateReaction, ctx, {
        findingId: 'findings:1',
        kind: 'mergedFixed',
      }),
    ).resolves.toBe(true);
    await expect(
      invoke(recordMergeStateReaction, ctx, {
        findingId: 'findings:1',
        kind: 'mergedIgnored',
      }),
    ).resolves.toBe(false);

    expect(ctx.db.tables.get('reactions')).toEqual([
      expect.objectContaining({ findingId: 'findings:1', kind: '👍' }),
      expect.objectContaining({ findingId: 'findings:1', kind: 'mergedFixed' }),
    ]);
  });

  it('lists merged PRs pending merge-state rollup and marks them rolled up', async () => {
    const ctx = fakeCtx();
    const repoId = await ctx.db.insert('repos', {
      productId: 'products:1',
      owner: 'acme',
      name: 'widget',
      fullName: 'acme/widget',
      defaultBranch: 'main',
    });
    const pendingId = await ctx.db.insert('pullRequests', {
      repoId,
      number: 12,
      state: 'merged',
      draft: false,
      headSha: 'head-sha',
      baseRef: 'main',
      title: 'Pending',
      author: 'octocat',
      url: 'https://example.test/pr/12',
      reviewActive: false,
    });
    await ctx.db.insert('pullRequests', {
      repoId,
      number: 13,
      state: 'merged',
      draft: false,
      headSha: 'head-sha',
      baseRef: 'main',
      title: 'Done',
      author: 'octocat',
      url: 'https://example.test/pr/13',
      reviewActive: false,
      mergeStateSignalsRolledUpAt: 100,
    });
    await ctx.db.insert('pullRequests', {
      repoId,
      number: 14,
      state: 'closed',
      draft: false,
      headSha: 'head-sha',
      baseRef: 'main',
      title: 'Closed',
      author: 'octocat',
      url: 'https://example.test/pr/14',
      reviewActive: false,
    });
    await ctx.db.insert('pullRequests', {
      repoId: 'repos:404',
      number: 15,
      state: 'merged',
      draft: false,
      headSha: 'head-sha',
      baseRef: 'main',
      title: 'Missing repo',
      author: 'octocat',
      url: 'https://example.test/pr/15',
      reviewActive: false,
    });

    await expect(invoke(listMergedForMergeStateBackfill, ctx, { limit: 10 })).resolves.toEqual([
      {
        pullRequestId: pendingId,
        repo: { owner: 'acme', name: 'widget' },
        pullNumber: 12,
      },
    ]);

    await invoke(markMergeStateSignalsRolledUp, ctx, {
      pullRequestId: pendingId,
      rolledUpAt: 1234,
    });

    expect(ctx.db.getDoc(pendingId)).toEqual(
      expect.objectContaining({ mergeStateSignalsRolledUpAt: 1234 }),
    );
  });
});

type ConvexFunctionForTest = {
  _handler(ctx: unknown, args: Record<string, unknown>): Promise<unknown>;
};

function invoke<T>(
  fn: ConvexFunctionForTest,
  ctx: ReturnType<typeof fakeCtx>,
  args: Record<string, unknown>,
): Promise<T> {
  return fn._handler(ctx, args) as Promise<T>;
}

function fakeCtx(): { db: FakeDb } {
  return { db: new FakeDb() };
}

class FakeDb {
  readonly tables = new Map<string, Array<Record<string, unknown>>>();

  async insert(table: string, doc: Record<string, unknown>): Promise<string> {
    const rows = this.table(table);
    const id = `${table}:${rows.length + 1}`;
    rows.push({ _id: id, _creationTime: rows.length + 1, ...doc });
    return id;
  }

  async get(id: string): Promise<Record<string, unknown> | null> {
    return this.getDoc(id);
  }

  getDoc(id: string): Record<string, unknown> | null {
    const [table] = id.split(':');
    return this.table(table ?? '').find((row) => row._id === id) ?? null;
  }

  async patch(id: string, patch: Record<string, unknown>): Promise<void> {
    const row = this.getDoc(id);
    if (row !== null) {
      Object.assign(row, patch);
    }
  }

  query(table: string): FakeQuery {
    return new FakeQuery([...this.table(table)]);
  }

  private table(name: string): Array<Record<string, unknown>> {
    const existing = this.tables.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const rows: Array<Record<string, unknown>> = [];
    this.tables.set(name, rows);
    return rows;
  }
}

class FakeQuery {
  constructor(private rows: Array<Record<string, unknown>>) {}

  withIndex(
    _name: string,
    apply: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
  ): FakeQuery {
    const filters: Array<{ field: string; value: unknown }> = [];
    apply({
      eq(field: string, value: unknown) {
        filters.push({ field, value });
        return this;
      },
    });
    this.rows = this.rows.filter((row) =>
      filters.every((filter) => row[filter.field] === filter.value),
    );
    return this;
  }

  order(direction: 'asc' | 'desc'): FakeQuery {
    this.rows.sort((left, right) => {
      const leftTime = Number(left._creationTime);
      const rightTime = Number(right._creationTime);
      return direction === 'asc' ? leftTime - rightTime : rightTime - leftTime;
    });
    return this;
  }

  async take(limit: number): Promise<Array<Record<string, unknown>>> {
    return this.rows.slice(0, limit);
  }

  async collect(): Promise<Array<Record<string, unknown>>> {
    return this.rows;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Record<string, unknown>> {
    for (const row of this.rows) {
      yield row;
    }
  }
}
