import { describe, expect, it } from 'vitest';
import type { LocalReviewResult } from './history.js';
import { listEntry, renderJson, renderList, renderText } from './render.js';

const REVIEW: LocalReviewResult = {
  id: '20261025T101500Z-a1b2c3',
  status: 'completed',
  repository: 'acme/widgets',
  branch: 'feature/sum',
  base: { ref: 'origin/main', sha: 'b'.repeat(40), mergeBase: 'c'.repeat(40) },
  head: 'a'.repeat(40),
  changedLines: 1234,
  confidenceScore: 3,
  summary: 'One correctness issue.\n',
  findings: [
    {
      id: 'finding-1',
      severity: 'P1',
      confidence: 4,
      category: 'logic',
      agentKey: 'logic',
      repo: 'acme/widgets',
      path: 'src/math.ts',
      lineStart: 2,
      lineEnd: 4,
      summary: 'add() subtracts its operands.',
      evidence: 'src/math.ts:2 returns a - b.\n\nsum([1, 2]) is -3.',
      suggestedFix: 'Return a + b.',
      alsoReportedBy: ['security'],
    },
    {
      id: 'finding-2',
      severity: 'P2',
      confidence: 3,
      category: 'compatibility',
      agentKey: 'security',
      repo: 'acme/api',
      path: 'src/routes.ts',
      lineStart: 9,
      lineEnd: 9,
      summary: 'The consumer still sends strings.',
      evidence: 'src/routes.ts:9 passes a string.',
      crossRepoReferences: [{ repo: 'acme/api', path: 'src/routes.ts', line: 9 }],
    },
  ],
  agents: [
    {
      key: 'logic',
      status: 'completed',
      findingCount: 1,
      durationMs: 125_000,
      usage: {
        inputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 25_000,
        outputTokens: 500,
      },
    },
    {
      key: 'security',
      status: 'timed_out',
      findingCount: 0,
      durationMs: 4400,
      error: 'Agent exceeded its time limit',
    },
  ],
  warnings: ['1 uncommitted change is not part of this review; only commits are reviewed'],
  startedAt: '2026-10-25T10:10:00.000Z',
  finishedAt: '2026-10-25T10:15:00.000Z',
};

describe('renderText', () => {
  it('lists Findings, reviewers, the summary, and warnings in plain text', () => {
    expect(renderText(REVIEW)).toBe(`Sandy review 20261025T101500Z-a1b2c3: completed
acme/widgets feature/sum at aaaaaaaaaaaa vs origin/main at bbbbbbbbbbbb (merge base cccccccccccc)
Confidence score: 3/5 (5 = clean) · 1,234 changed lines · 2 findings

1. [P1] logic · src/math.ts:2-4 · confidence 4/5 · logic
   add() subtracts its operands.
   Evidence:
     src/math.ts:2 returns a - b.

     sum([1, 2]) is -3.
   Possible direction (unverified):
     Return a + b.
   Also reported by: security

2. [P2] compatibility · acme/api/src/routes.ts:9 · confidence 3/5 · security
   The consumer still sends strings.
   Evidence:
     src/routes.ts:9 passes a string.
   Cross-repo references:
     - acme/api/src/routes.ts:9

Reviewers:
- logic: completed, 1 finding, 2m 05s, 1,000 input + 25,000 cached + 500 output tokens
- security: timed out, 4s
    Agent exceeded its time limit

Summary:
One correctness issue.

Warnings:
- 1 uncommitted change is not part of this review; only commits are reviewed

Show this Review again with: sandy review show 20261025T101500Z-a1b2c3
`);
  });

  it('omits the show hint when there was nothing to review', () => {
    expect(
      renderText({
        ...REVIEW,
        status: 'no_changes',
        branch: null,
        changedLines: null,
        confidenceScore: null,
        summary: 'HEAD has no committed changes against origin/main.',
        findings: [],
        agents: [],
        warnings: [],
      }),
    ).toBe(`Sandy review 20261025T101500Z-a1b2c3: nothing to review
acme/widgets detached HEAD at aaaaaaaaaaaa vs origin/main at bbbbbbbbbbbb (merge base cccccccccccc)
Confidence score: not scored · 0 findings

Summary:
HEAD has no committed changes against origin/main.
`);
  });

  it('shows why a Review failed', () => {
    const text = renderText({
      ...REVIEW,
      status: 'failed',
      confidenceScore: null,
      error: 'Review worktree could not be created',
      summary: '',
      findings: [],
      agents: [],
      warnings: [],
    });

    expect(text).toContain('Sandy review 20261025T101500Z-a1b2c3: failed\n');
    expect(text).toContain('\n\nError: Review worktree could not be created\n\n');
    expect(text).not.toContain('Summary:');
  });
});

describe('renderJson', () => {
  it('prints the whole result as one JSON object', () => {
    expect(JSON.parse(renderJson(REVIEW))).toEqual(REVIEW);
    expect(renderJson(REVIEW).endsWith('}\n')).toBe(true);
  });
});

describe('renderList', () => {
  it('says when nothing is saved', () => {
    expect(renderList([])).toBe('No saved Reviews.\n');
  });

  it('aligns one row per Review', () => {
    const older: LocalReviewResult = {
      ...REVIEW,
      id: '20261025T090000Z-d4e5f6',
      status: 'incomplete',
      branch: null,
      confidenceScore: null,
      findings: [],
      finishedAt: '2026-10-25T09:04:00Z',
    };

    expect(renderList([REVIEW, older])).toBe(
      [
        'ID                       STATUS      SCORE  FINDINGS  REPOSITORY    BRANCH         FINISHED',
        '20261025T101500Z-a1b2c3  completed   3/5    2         acme/widgets  feature/sum    2026-10-25 10:15:00 UTC',
        '20261025T090000Z-d4e5f6  incomplete  -      0         acme/widgets  detached HEAD  2026-10-25 09:04:00 UTC',
        '',
      ].join('\n'),
    );
  });
});

describe('listEntry', () => {
  it('summarizes a saved Review', () => {
    expect(listEntry(REVIEW)).toEqual({
      id: '20261025T101500Z-a1b2c3',
      status: 'completed',
      repository: 'acme/widgets',
      branch: 'feature/sum',
      head: 'a'.repeat(40),
      confidenceScore: 3,
      findingCount: 2,
      finishedAt: '2026-10-25T10:15:00.000Z',
    });
  });
});
