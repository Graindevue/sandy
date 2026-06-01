import type { Finding } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import { FindingArchetypeAssigner } from './archetype-assigner.js';

const finding: Finding = {
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

describe('FindingArchetypeAssigner', () => {
  it('embeds persisted Finding summaries and returns archetype-stamped Findings', async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeArchetypeStore();
    const assigner = new FindingArchetypeAssigner(embedder, store);

    const stamped = await assigner.assignArchetypes([{ id: 'finding-1', finding }]);

    expect(embedder.summaries).toEqual(['The cache key ignores the tenant id.']);
    expect(store.assignments).toEqual([{ findingId: 'finding-1', embedding: [0.1, 0.2, 0.3] }]);
    expect(stamped).toEqual([{ id: 'finding-1', archetypeId: 'archetype-1', finding }]);
  });
});

class FakeEmbedder {
  summaries: string[] = [];

  async embedFindingSummary(summary: string): Promise<number[]> {
    this.summaries.push(summary);
    return [0.1, 0.2, 0.3];
  }
}

class FakeArchetypeStore {
  assignments: Array<{ findingId: string; embedding: number[] }> = [];

  async assignArchetype(input: {
    findingId: string;
    embedding: number[];
  }): Promise<{ archetypeId: string }> {
    this.assignments.push(input);
    return { archetypeId: `archetype-${this.assignments.length}` };
  }
}
