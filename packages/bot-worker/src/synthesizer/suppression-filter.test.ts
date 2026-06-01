import type { Finding } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import type { ArchetypeAssignedFinding } from '../worker/review-findings.js';
import { filterSuppressedFindings } from './suppression-filter.js';

const baseFinding: Finding = {
  severity: 'P1',
  confidence: 4,
  agentKey: 'logic',
  anchor: {
    repo: 'acme/widget',
    path: 'src/cache.ts',
    lineStart: 12,
    lineEnd: 12,
  },
  summary: 'The cache key ignores the tenant id.',
  evidence: 'The lookup only uses userId.',
  suggestedFix: 'Include tenantId.',
  category: 'logic',
};

describe('filterSuppressedFindings', () => {
  it('drops Findings whose Archetype suppression weight is at or above the threshold', () => {
    const findings = [
      assignedFinding('below-threshold', 0.69),
      assignedFinding('at-threshold', 0.7),
      assignedFinding('above-threshold', 1),
    ];

    expect(filterSuppressedFindings(findings)).toEqual([findings[0]]);
  });
});

function assignedFinding(id: string, archetypeSuppressionWeight: number): ArchetypeAssignedFinding {
  return {
    id,
    archetypeId: `archetype-${id}`,
    archetypeSuppressionWeight,
    finding: { ...baseFinding, summary: `Finding ${id}` },
  };
}
