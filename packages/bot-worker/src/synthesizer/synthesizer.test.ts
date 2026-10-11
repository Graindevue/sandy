import type { Finding } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import {
  synthesizeAgentOutputs,
  synthesizePostableReview,
  synthesizeReview,
} from './synthesizer.js';

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

const skippedCrossRepoSearch = {
  status: 'skipped' as const,
  trigger: 'none' as const,
  rationale: 'No cross-repo contract risk was detected.',
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

  it('dedupes transitively through nearby duplicate clusters', () => {
    const result = synthesizeReview({
      findings: [
        baseFinding,
        {
          ...baseFinding,
          anchor: { ...baseFinding.anchor, lineStart: 24, lineEnd: 24 },
          confidence: 5,
        },
        {
          ...baseFinding,
          anchor: { ...baseFinding.anchor, lineStart: 26, lineEnd: 26 },
          severity: 'P0',
        },
      ],
      changedLineCount: 80,
      agentSummaries: [],
    });

    expect(result.findings).toEqual([expect.objectContaining({ severity: 'P0' })]);
  });

  it('uses the completed Agent key as the authoritative Finding producer', () => {
    const result = synthesizeAgentOutputs({
      agentOutputs: [
        {
          agentKey: 'security',
          payload: {
            summary: 'One issue found.',
            crossRepoSearch: skippedCrossRepoSearch,
            findings: [{ ...baseFinding, agentKey: 'model-supplied-key' }],
          },
        },
      ],
      changedLineCount: 80,
    });

    expect(result.findings).toEqual([expect.objectContaining({ agentKey: 'security' })]);
    expect(result.summary).toContain('One issue found.');
    expect(result.summary).toContain(
      'Cross-repo search:\n- security: skipped (none) - No cross-repo contract risk was detected.',
    );
  });

  it('builds a summary comment that surfaces the persisted confidence score', () => {
    const result = synthesizeReview({
      findings: [baseFinding],
      changedLineCount: 80,
      agentSummaries: [{ agentKey: 'logic', summary: 'One issue found.' }],
    });

    expect(result.confidenceScore).toBe(3);
    expect(result.summary).toContain('Confidence score: 3/5');
    expect(result.summary).toContain('Sandy review posted 1 finding.');
    expect(result.summary).toContain('One issue found.');
  });

  it('reports full confidence when there are no findings', () => {
    const result = synthesizeReview({
      findings: [],
      changedLineCount: 80,
      agentSummaries: [
        { agentKey: 'logic', summary: 'Nothing to flag.' },
        { agentKey: 'convex', summary: 'Ran the focused query tests; nothing to flag.' },
      ],
    });

    expect(result.confidenceScore).toBe(5);
    expect(result.summary).toContain('Confidence score: 5/5');
    expect(result.summary).toContain(
      'Sandy review found no issues. Agents that ran: logic, convex; 80 changed lines reviewed.',
    );
    expect(result.summary).not.toContain('no findings posted');
  });

  it('lowers the confidence score for cross-repo blast radius', () => {
    const result = synthesizeReview({
      findings: [
        {
          ...baseFinding,
          severity: 'P2',
          confidence: 1,
          crossRepoReferences: [{ repo: 'acme/desktop', path: 'src/orders.ts', line: 31 }],
        },
      ],
      changedLineCount: 80,
      agentSummaries: [],
    });

    expect(result.confidenceScore).toBe(3);
  });

  it('does not lower the score for diff size alone and prints what the score is made of', () => {
    const result = synthesizeReview({
      findings: [{ ...baseFinding, confidence: 5 }],
      changedLineCount: 4991,
      agentSummaries: [],
    });

    expect(result.confidenceScore).toBe(2);
    expect(result.summary).toContain(
      'Confidence score: 2/5 (5 = clean; 1 P1 finding across 4,991 changed lines)',
    );
  });

  it('names the Agent behind every summary bullet and keeps Agents that returned none', () => {
    const result = synthesizeAgentOutputs({
      agentOutputs: [
        {
          agentKey: 'logic',
          payload: {
            summary: 'One issue found.',
            crossRepoSearch: skippedCrossRepoSearch,
            findings: [],
          },
        },
        { agentKey: 'convex', payload: { crossRepoSearch: skippedCrossRepoSearch, findings: [] } },
        {
          agentKey: 'security',
          payload: {
            summary: 'One issue found.',
            crossRepoSearch: skippedCrossRepoSearch,
            findings: [],
          },
        },
      ],
      changedLineCount: 80,
    });

    expect(result.summary).toContain(
      'Agent summaries:\n- logic: One issue found.\n- convex: (no summary returned)\n- security: One issue found.',
    );
  });

  it('does not score or call a Review clean when a selected Agent failed', () => {
    const result = synthesizeAgentOutputs({
      agentOutputs: [
        {
          agentKey: 'logic',
          payload: {
            summary: 'Nothing to flag.',
            crossRepoSearch: skippedCrossRepoSearch,
            findings: [],
          },
        },
      ],
      failedAgentKeys: ['convex'],
      changedLineCount: 80,
    });

    expect(result.confidenceScore).toBeNull();
    expect(result.summary).toContain('Confidence score: not scored (review incomplete)');
    expect(result.summary).toContain(
      'Review incomplete: 1 of 2 Agents failed (convex). Findings below come only from logic.',
    );
    expect(result.summary).not.toContain('5/5');
    expect(result.summary).not.toContain('found no issues');
    expect(result.summary).toContain(
      'Agent summaries:\n- logic: Nothing to flag.\n- convex: (failed; no findings returned)',
    );
  });

  it('keeps the incomplete warning on the postable summary', () => {
    const result = synthesizePostableReview({
      archetypeAssignedFindings: [],
      agentOutputs: [],
      failedAgentKeys: ['logic', 'convex'],
      changedLineCount: 80,
      rawFindingCount: 0,
    });

    expect(result.summary).toContain('Review incomplete: 2 of 2 Agents failed (logic, convex).');
  });

  it('builds a postable review after applying Archetype suppression', () => {
    const suppressedFinding: Finding = {
      ...baseFinding,
      severity: 'P0',
      confidence: 5,
      summary: 'The cache key ignores the tenant id.',
    };
    const postableFinding: Finding = {
      ...baseFinding,
      severity: 'P2',
      confidence: 1,
      anchor: { ...baseFinding.anchor, lineStart: 23, lineEnd: 23 },
      summary: 'The retry loop never backs off after a rate limit.',
    };

    const result = synthesizePostableReview({
      archetypeAssignedFindings: [
        assignedFinding('finding-1', suppressedFinding, 0.7),
        assignedFinding('finding-2', postableFinding, 0.69),
      ],
      agentOutputs: [
        {
          agentKey: 'logic',
          payload: {
            summary: 'Two issues found.',
            crossRepoSearch: skippedCrossRepoSearch,
            findings: [],
          },
        },
      ],
      changedLineCount: 80,
      rawFindingCount: 2,
    });

    expect(result.findings).toEqual([
      { id: 'finding-2', archetypeId: 'archetype-finding-2', finding: postableFinding },
    ]);
    expect(result.summary).toContain('Confidence score: 4/5');
    expect(result.summary).toContain('Synthesized 2 raw findings into 1 posted finding.');
    expect(result.summary).toContain('Two issues found.');
    expect(result.summary).toContain(postableFinding.summary);
    expect(result.summary).not.toContain(suppressedFinding.summary);
  });
});

function assignedFinding(id: string, finding: Finding, archetypeSuppressionWeight: number) {
  return {
    id,
    archetypeId: `archetype-${id}`,
    archetypeSuppressionWeight,
    finding,
  };
}
