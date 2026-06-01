import type { SuggestedRuleStatus } from '@sandy/shared-types';
import { afterEach, describe, expect, it } from 'vitest';
import { recentByArchetype } from '../convex/reactions.js';
import {
  candidatesForReactionInference,
  createIfEvidenceThresholdMet,
  draftSuggestedRuleDescription,
  inferSuggestedRulesFromReactions,
  markPromoted,
  promoteSuppression,
  scoreReactionEvidence,
  subscribePending,
  subscribePositivePromotions,
  subscribeSuppressionPromotions,
} from '../convex/suggestedRules.js';

const originalFetch = globalThis.fetch;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalAnthropicModel = process.env.ANTHROPIC_SUGGESTED_RULE_MODEL;

describe('SuggestedRule inference from reactions', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicApiKey);
    restoreEnv('ANTHROPIC_SUGGESTED_RULE_MODEL', originalAnthropicModel);
  });

  it('creates one pending suppression SuggestedRule after three negative reactions', async () => {
    const ctx = fakeCtx();
    const { archetypeId, findingIds, reactionIds } = await seedArchetypeWithFindings(ctx);
    await ctx.db.insert('reactions', {
      findingId: findingIds[0],
      kind: '👎',
      replyText: 'This is noise because the test already covers the branch.',
    });
    await ctx.db.insert('reactions', { findingId: findingIds[1], kind: '👎' });
    await ctx.db.insert('reactions', { findingId: findingIds[2], kind: '👎' });

    const createdId = await invoke(createIfEvidenceThresholdMet, ctx, {
      sourceArchetypeId: archetypeId,
      description: 'Suppress duplicate test-coverage findings for already-covered branches.',
    });
    const duplicateId = await invoke(createIfEvidenceThresholdMet, ctx, {
      sourceArchetypeId: archetypeId,
      description: 'A second draft should not be created.',
    });
    const pending = await invoke<Array<Record<string, unknown>>>(subscribePending, ctx, {});

    expect(createdId).toBe('suggestedRules:1');
    expect(duplicateId).toBeNull();
    expect(pending).toEqual([
      expect.objectContaining({
        _id: createdId,
        status: 'suggested',
        type: 'suppression',
        sourceArchetypeId: archetypeId,
        description: 'Suppress duplicate test-coverage findings for already-covered branches.',
      }),
    ]);
    expect(ctx.db.getDoc(archetypeId)).toEqual(expect.objectContaining({ suppressionWeight: 1 }));
    expect(ctx.db.tables.get('suggestedRules')).toHaveLength(1);

    const evidence = JSON.parse(String(pending[0]?.evidence));
    expect(evidence).toEqual(
      expect.objectContaining({
        sourceArchetypeId: archetypeId,
        threshold: 3,
        negativeScore: 3,
        suppressionWeight: 1,
      }),
    );
    expect(evidence.reactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reactionId: reactionIds[0],
          findingId: findingIds[0],
          kind: '👎',
        }),
        expect.objectContaining({
          reactionId: reactionIds[1],
          findingId: findingIds[1],
          kind: '👎',
        }),
        expect.objectContaining({
          reactionId: reactionIds[2],
          findingId: findingIds[2],
          kind: '👎',
        }),
      ]),
    );
  });

  it('subscribes only to suppression SuggestedRules awaiting promotion work', async () => {
    const ctx = fakeCtx();
    const { archetypeId } = await seedArchetypeWithFindings(ctx);
    await ctx.db.insert('suggestedRules', suggestedRule(archetypeId, 'suggested'));
    const suppressionId = await ctx.db.insert(
      'suggestedRules',
      suggestedRule(archetypeId, 'promoteToSuppression'),
    );
    const positiveId = await ctx.db.insert(
      'suggestedRules',
      suggestedRule(archetypeId, 'promoteToPositive'),
    );
    await ctx.db.insert('suggestedRules', suggestedRule(archetypeId, 'rejected'));
    await ctx.db.insert('suggestedRules', suggestedRule(archetypeId, 'promoted'));

    const pending = await invoke<Array<Record<string, unknown>>>(
      subscribeSuppressionPromotions,
      ctx,
      {},
    );

    expect(positiveId).toBe('suggestedRules:3');
    expect(pending.map((rule) => rule._id)).toEqual([suppressionId]);
    expect(pending.map((rule) => rule.status)).toEqual(['promoteToSuppression']);
  });

  it('hydrates positive promotion work with exemplars and the most-affected Repo', async () => {
    const ctx = fakeCtx();
    const { archetypeId, findingIds, productId } = await seedArchetypeWithFindings(ctx);
    await ctx.db.patch(archetypeId, { exampleFindingIds: [findingIds[1]] });
    await ctx.db.insert('repos', {
      productId,
      owner: 'acme',
      name: 'desktop',
      fullName: 'acme/desktop',
      defaultBranch: 'main',
    });
    await ctx.db.insert('findings', {
      reviewJobId: 'reviewJobs:1',
      pullRequestId: 'pullRequests:1',
      agentKey: 'logic',
      severity: 'P2',
      confidence: 3,
      anchor: { repo: 'acme/desktop', path: 'src/view.ts', lineStart: 7, lineEnd: 7 },
      summary: 'Desktop duplicate example.',
      evidence: 'Desktop already handles this case.',
      category: 'logic',
      archetypeId,
    });
    const suggestedRuleId = await ctx.db.insert(
      'suggestedRules',
      suggestedRule(archetypeId, 'promoteToPositive'),
    );

    const pending = await invoke<Array<Record<string, unknown>>>(subscribePositivePromotions, ctx, {
      exemplarLimit: 2,
    });

    expect(pending).toEqual([
      expect.objectContaining({
        _id: suggestedRuleId,
        archetypeLabel: 'Duplicate test coverage finding',
        targetRepo: expect.objectContaining({
          _id: 'repos:1',
          fullName: 'acme/widget',
          defaultBranch: 'main',
        }),
        exemplars: expect.arrayContaining([
          expect.objectContaining({
            findingId: findingIds[1],
            summary: 'Duplicate review comment on a branch already covered by tests.',
          }),
        ]),
      }),
    ]);
  });

  it('promotes a suppression SuggestedRule atomically with its source Archetype', async () => {
    const ctx = fakeCtx();
    const { archetypeId } = await seedArchetypeWithFindings(ctx);
    const suggestedRuleId = await ctx.db.insert(
      'suggestedRules',
      suggestedRule(archetypeId, 'promoteToSuppression'),
    );

    await expect(invoke(promoteSuppression, ctx, { suggestedRuleId })).resolves.toBe(true);

    expect(ctx.db.getDoc(archetypeId)).toEqual(expect.objectContaining({ suppressionWeight: 1 }));
    expect(ctx.db.getDoc(suggestedRuleId)).toEqual(expect.objectContaining({ status: 'promoted' }));
  });

  it('marks a SuggestedRule promoted only when the expected operator decision still matches', async () => {
    const ctx = fakeCtx();
    const { archetypeId } = await seedArchetypeWithFindings(ctx);
    const suggestedRuleId = await ctx.db.insert(
      'suggestedRules',
      suggestedRule(archetypeId, 'rejected'),
    );

    await expect(
      invoke(markPromoted, ctx, {
        suggestedRuleId,
        expectedStatus: 'promoteToPositive',
      }),
    ).resolves.toBe(false);

    expect(ctx.db.getDoc(suggestedRuleId)).toEqual(expect.objectContaining({ status: 'rejected' }));

    await ctx.db.patch(suggestedRuleId, { status: 'promoteToPositive' });
    await expect(
      invoke(markPromoted, ctx, {
        suggestedRuleId,
        expectedStatus: 'promoteToPositive',
      }),
    ).resolves.toBe(true);

    expect(ctx.db.getDoc(suggestedRuleId)).toEqual(expect.objectContaining({ status: 'promoted' }));
  });

  it('does not promote a SuggestedRule whose operator decision changed', async () => {
    const ctx = fakeCtx();
    const { archetypeId } = await seedArchetypeWithFindings(ctx);
    const suggestedRuleId = await ctx.db.insert(
      'suggestedRules',
      suggestedRule(archetypeId, 'rejected'),
    );

    await expect(invoke(promoteSuppression, ctx, { suggestedRuleId })).resolves.toBe(false);

    expect(ctx.db.getDoc(archetypeId)).toEqual(expect.objectContaining({ suppressionWeight: 0 }));
    expect(ctx.db.getDoc(suggestedRuleId)).toEqual(expect.objectContaining({ status: 'rejected' }));
  });

  it('daily inference action drafts from reactions and creates the SuggestedRule', async () => {
    const ctx = fakeActionCtx();
    const { archetypeId, findingIds } = await seedArchetypeWithFindings(ctx);
    await ctx.db.insert('reactions', { findingId: findingIds[0], kind: '👎' });
    await ctx.db.insert('reactions', { findingId: findingIds[1], kind: '👎' });
    await ctx.db.insert('reactions', {
      findingId: findingIds[2],
      kind: '👎',
      replyText: 'This repeats a review comment that operators rejected.',
    });

    await expect(invoke(inferSuggestedRulesFromReactions, ctx, {})).resolves.toEqual({
      candidates: 1,
      created: 1,
      skipped: 0,
      failed: 0,
    });

    expect(ctx.db.tables.get('suggestedRules')).toEqual([
      expect.objectContaining({
        sourceArchetypeId: archetypeId,
        status: 'suggested',
        description: expect.stringContaining(
          'This repeats a review comment that operators rejected.',
        ),
      }),
    ]);
  });

  it('scores mixed reactions by weighted negative ratio and treats mergedIgnored as one third negative', async () => {
    const score = scoreReactionEvidence([
      reaction('reactions:1', 'findings:1', '👎'),
      reaction('reactions:2', 'findings:2', '👎'),
      reaction('reactions:3', 'findings:3', 'mergedIgnored'),
      reaction('reactions:4', 'findings:4', '👍'),
      reaction('reactions:5', 'findings:5', 'mergedFixed'),
      reaction('reactions:6', 'findings:6', 'reply', 'This is flaky noise.'),
    ]);

    expect(score.negativeScore).toBeCloseTo(2 + 1 / 3);
    expect(score.totalScore).toBe(5);
    expect(score.suppressionWeight).toBeCloseTo((2 + 1 / 3) / 5);
    expect(score.supportingReactions.map((support) => support.reactionId)).toEqual([
      'reactions:1',
      'reactions:2',
      'reactions:3',
      'reactions:6',
    ]);
  });

  it('does not create a SuggestedRule below the weighted negative threshold', async () => {
    const ctx = fakeCtx();
    const { archetypeId, findingIds } = await seedArchetypeWithFindings(ctx);
    await ctx.db.insert('reactions', { findingId: findingIds[0], kind: '👎' });
    await ctx.db.insert('reactions', { findingId: findingIds[1], kind: 'mergedIgnored' });
    await ctx.db.insert('reactions', { findingId: findingIds[2], kind: '👍' });

    await expect(
      invoke(createIfEvidenceThresholdMet, ctx, {
        sourceArchetypeId: archetypeId,
        description: 'Not enough negative signal.',
      }),
    ).resolves.toBeNull();

    expect(ctx.db.tables.get('suggestedRules') ?? []).toHaveLength(0);
    expect(ctx.db.getDoc(archetypeId)).toEqual(
      expect.objectContaining({ suppressionWeight: (1 + 1 / 3) / 3 }),
    );
  });

  it('lists recent reactions for an Archetype with Finding summaries for drafting', async () => {
    const ctx = fakeCtx();
    const { archetypeId, findingIds } = await seedArchetypeWithFindings(ctx);
    await ctx.db.insert('reactions', { findingId: findingIds[0], kind: '👍' });
    const secondReactionId = await ctx.db.insert('reactions', {
      findingId: findingIds[1],
      kind: '👎',
      replyText: 'The suggested fix is not actionable.',
    });

    await expect(invoke(recentByArchetype, ctx, { archetypeId })).resolves.toEqual([
      expect.objectContaining({
        _id: secondReactionId,
        findingId: findingIds[1],
        kind: '👎',
        replyText: 'The suggested fix is not actionable.',
        findingSummary: 'Duplicate review comment on a branch already covered by tests.',
      }),
      expect.objectContaining({ findingId: findingIds[0], kind: '👍' }),
    ]);
  });

  it('seeds the LLM draft prompt with reviewer reply text', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> =
      [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'Drafted rule text.' }] }),
        {
          status: 200,
        },
      );
    };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANTHROPIC_SUGGESTED_RULE_MODEL = 'claude-test-haiku';

    await expect(
      draftSuggestedRuleDescription({
        archetypeLabel: 'Duplicate test coverage finding',
        reactions: [
          {
            reactionId: 'reactions:1',
            findingId: 'findings:1',
            kind: '👎',
            replyText: 'The branch is already covered by parameterized tests.',
            findingSummary: 'Duplicate review comment on a branch already covered by tests.',
            createdAt: 1,
          },
        ],
      }),
    ).resolves.toBe('Drafted rule text.');

    expect(calls[0]?.input).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.init?.headers).toEqual({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test',
    });
    expect(JSON.stringify(JSON.parse(String(calls[0]?.init?.body)))).toContain(
      'The branch is already covered by parameterized tests.',
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

function fakeActionCtx(): ReturnType<typeof fakeCtx> & {
  runMutation: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  runQuery: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
} {
  const ctx = fakeCtx() as ReturnType<typeof fakeActionCtx>;
  ctx.runQuery = async (_ref, args) => {
    if ('archetypeId' in args) {
      return await invoke(recentByArchetype, ctx, args);
    }
    return await invoke(candidatesForReactionInference, ctx, args);
  };
  ctx.runMutation = async (_ref, args) => {
    return await invoke(createIfEvidenceThresholdMet, ctx, args);
  };
  return ctx;
}

async function seedArchetypeWithFindings(ctx: ReturnType<typeof fakeCtx>) {
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
  const archetypeId = await ctx.db.insert('archetypes', {
    productId,
    label: 'Duplicate test coverage finding',
    exemplarEmbedding: [0.1],
    exampleFindingIds: [],
    count: 3,
    suppressionWeight: 0,
  });
  const summaries = [
    'The review asks for a test that already exists.',
    'Duplicate review comment on a branch already covered by tests.',
    'The Finding repeats established fixture coverage.',
  ];
  const findingIds = [];
  for (const summary of summaries) {
    findingIds.push(
      await ctx.db.insert('findings', {
        reviewJobId: 'reviewJobs:1',
        pullRequestId,
        agentKey: 'logic',
        severity: 'P2',
        confidence: 3,
        anchor: { repo: 'acme/widget', path: 'src/cache.ts', lineStart: 12, lineEnd: 12 },
        summary,
        evidence: 'Fixture coverage exists.',
        category: 'test-coverage',
        archetypeId,
      }),
    );
  }

  return {
    productId,
    repoId,
    pullRequestId,
    archetypeId,
    findingIds,
    reactionIds: ['reactions:1', 'reactions:2', 'reactions:3'],
  };
}

function reaction(reactionId: string, findingId: string, kind: string, replyText?: string) {
  return {
    reactionId,
    findingId,
    kind,
    ...(replyText === undefined ? {} : { replyText }),
    findingSummary: `Summary for ${findingId}`,
    createdAt: 1,
  };
}

function suggestedRule(
  sourceArchetypeId: string,
  status: SuggestedRuleStatus,
): Record<string, unknown> {
  return {
    productId: 'products:1',
    type: status === 'promoteToPositive' ? 'positive' : 'suppression',
    status,
    description: `Rule with status ${status}`,
    sourceArchetypeId,
    evidence: '{}',
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
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

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Record<string, unknown>> {
    for (const row of this.rows) {
      yield row;
    }
  }
}
