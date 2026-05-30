import type { Finding } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import { synthesizeReview } from './synthesizer.js';

const baseFinding: Finding = {
  severity: 'P1',
  confidence: 4,
  agentKey: 'logic',
  anchor: {
    repo: 'acme/widget',
    path: 'src/cache.ts',
    lineStart: 22,
    lineEnd: 22,
  },
  summary: 'The cache key ignores the tenant id.',
  evidence: 'The lookup only uses userId.',
  suggestedFix: 'Include tenantId in the cache key.',
  category: 'logic',
};

describe('synthesizeReview', () => {
  it('dedupes near-identical Findings at nearby locations and keeps the stronger one', () => {
    const result = synthesizeReview({
      findings: [
        baseFinding,
        {
          ...baseFinding,
          severity: 'P0',
          confidence: 5,
          agentKey: 'security',
          summary: 'Cache key ignores tenant id.',
          evidence: 'The endpoint accepts tenant-scoped input but drops tenantId.',
          category: 'security',
        },
      ],
      changedLineCount: 80,
      agentSummaries: [],
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: 'P0',
        confidence: 5,
        agentKey: 'security',
        category: 'security',
      }),
    ]);
  });

  it('keeps same-file Findings separate when their summaries are unrelated', () => {
    const result = synthesizeReview({
      findings: [
        baseFinding,
        {
          ...baseFinding,
          anchor: { ...baseFinding.anchor, lineStart: 23, lineEnd: 23 },
          summary: 'The retry loop never backs off after a rate limit.',
          evidence: 'The loop immediately retries after 429.',
        },
      ],
      changedLineCount: 80,
      agentSummaries: [],
    });

    expect(result.findings).toHaveLength(2);
  });

  it('builds a summary comment that surfaces the persisted confidence score', () => {
    const result = synthesizeReview({
      findings: [baseFinding],
      changedLineCount: 80,
      agentSummaries: ['One issue found.'],
    });

    expect(result.confidenceScore).toBe(2);
    expect(result.summary).toContain('Confidence score: 2/5');
    expect(result.summary).toContain('Sandy review posted 1 finding.');
    expect(result.summary).toContain('One issue found.');
  });

  it('raises the confidence score for large cross-repo blast radius', () => {
    const result = synthesizeReview({
      findings: [
        {
          ...baseFinding,
          severity: 'P2',
          confidence: 1,
          crossRepoReferences: [{ repo: 'acme/desktop', path: 'src/orders.ts', line: 31 }],
        },
      ],
      changedLineCount: 1000,
      agentSummaries: [],
    });

    expect(result.confidenceScore).toBe(4);
  });
});
