import { describe, expect, it } from 'vitest';
import {
  assignmentContext,
  assignOrCreateArchetype,
  persistAssignment,
} from '../convex/archetypes.js';

describe('Archetype assignment', () => {
  it('clusters similar embeddings only within the same agent', async () => {
    const ctx = fakeActionCtx();
    const { pullRequestId } = await seedProduct(ctx);
    const firstFindingId = await insertFinding(ctx, {
      pullRequestId,
      agentKey: 'logic',
      summary: 'Route cache is flushed without checking authentication.',
    });
    const similarFindingId = await insertFinding(ctx, {
      pullRequestId,
      agentKey: 'logic',
      summary: 'Unauthenticated users can force the route cache to flush.',
    });
    const otherAgentFindingId = await insertFinding(ctx, {
      pullRequestId,
      agentKey: 'security',
      summary: 'Unauthenticated users can force the route cache to flush.',
    });

    const first = await invoke<{ archetypeId: string }>(assignOrCreateArchetype, ctx, {
      findingId: firstFindingId,
      embedding: unitVector(),
    });
    const similar = await invoke<{ archetypeId: string }>(assignOrCreateArchetype, ctx, {
      findingId: similarFindingId,
      embedding: vectorWithCosine(0.81),
    });
    const otherAgent = await invoke<{ archetypeId: string }>(assignOrCreateArchetype, ctx, {
      findingId: otherAgentFindingId,
      embedding: vectorWithCosine(0.81),
    });

    expect(similar.archetypeId).toBe(first.archetypeId);
    expect(otherAgent.archetypeId).not.toBe(first.archetypeId);
    expect(ctx.db.table('archetypes')).toEqual([
      expect.objectContaining({
        _id: first.archetypeId,
        productId: 'products:1',
        agentKey: 'logic',
        count: 2,
        exampleFindingIds: [firstFindingId, similarFindingId],
      }),
      expect.objectContaining({
        _id: otherAgent.archetypeId,
        productId: 'products:1',
        agentKey: 'security',
        count: 1,
        exampleFindingIds: [otherAgentFindingId],
      }),
    ]);
  });
});

type ConvexFunctionForTest = {
  _handler(ctx: unknown, args: Record<string, unknown>): Promise<unknown>;
};

function invoke<T>(
  fn: ConvexFunctionForTest,
  ctx: ReturnType<typeof fakeActionCtx>,
  args: Record<string, unknown>,
): Promise<T> {
  return fn._handler(ctx, args) as Promise<T>;
}

function fakeActionCtx(): {
  db: FakeDb;
  runMutation: RunFunction;
  runQuery: RunFunction;
  vectorSearch: VectorSearch;
} {
  const ctx = {
    db: new FakeDb(),
    runQuery: async (_ref: unknown, args: Record<string, unknown>) => {
      return await assignmentContext._handler(ctx, args);
    },
    runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
      return await persistAssignment._handler(ctx, args);
    },
    vectorSearch: async (
      table: string,
      _index: string,
      { vector, limit, filter }: VectorSearchArgs,
    ): Promise<Array<{ _id: string; _score: number }>> => {
      const filters: Array<{ field: string; value: unknown }> = [];
      filter({
        eq(field: string, value: unknown) {
          filters.push({ field, value });
          return this;
        },
      });
      return ctx.db
        .table(table)
        .filter((row) => filters.every(({ field, value }) => row[field] === value))
        .map((row) => ({
          _id: String(row._id),
          _score: cosine(vector, row.exemplarEmbedding as number[]),
        }))
        .sort((left, right) => right._score - left._score)
        .slice(0, limit);
    },
  };
  return ctx;
}

type RunFunction = (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
type VectorSearch = (
  table: string,
  index: string,
  args: VectorSearchArgs,
) => Promise<Array<{ _id: string; _score: number }>>;

type VectorSearchArgs = {
  vector: number[];
  limit: number;
  filter: (q: { eq(field: string, value: unknown): unknown }) => unknown;
};

async function seedProduct(ctx: { db: FakeDb }) {
  const productId = await ctx.db.insert('products', { slug: 'acme', name: 'Acme' });
  const repoId = await ctx.db.insert('repos', {
    productId,
    owner: 'acme',
    name: 'widget',
    fullName: 'acme/widget',
    defaultBranch: 'main',
  });
  const pullRequestId = await ctx.db.insert('pullRequests', {
    repoId,
    number: 12,
    state: 'open',
    draft: false,
    headSha: 'head-sha',
    baseRef: 'main',
    title: 'PR',
    author: 'octocat',
    url: 'https://example.test/pr/12',
    reviewActive: true,
  });
  return { productId, repoId, pullRequestId };
}

async function insertFinding(
  ctx: { db: FakeDb },
  input: { pullRequestId: string; agentKey: string; summary: string },
): Promise<string> {
  return await ctx.db.insert('findings', {
    reviewJobId: 'reviewJobs:1',
    pullRequestId: input.pullRequestId,
    agentKey: input.agentKey,
    severity: 'P2',
    confidence: 3,
    anchor: { repo: 'acme/widget', path: 'src/cache.ts', lineStart: 12, lineEnd: 12 },
    summary: input.summary,
    evidence: 'Cache flush route has no auth guard.',
    category: 'security',
  });
}

function unitVector(): number[] {
  return [1, ...Array(767).fill(0)];
}

function vectorWithCosine(score: number): number[] {
  return [score, Math.sqrt(1 - score ** 2), ...Array(766).fill(0)];
}

function cosine(left: number[], right: number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const leftMagnitude = Math.sqrt(left.reduce((sum, value) => sum + value ** 2, 0));
  const rightMagnitude = Math.sqrt(right.reduce((sum, value) => sum + value ** 2, 0));
  return dot / (leftMagnitude * rightMagnitude);
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

  table(name: string): Array<Record<string, unknown>> {
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

  async take(limit: number): Promise<Array<Record<string, unknown>>> {
    return this.rows.slice(0, limit);
  }
}
