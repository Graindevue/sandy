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
    expect(stamped).toEqual([
      {
        id: 'finding-1',
        archetypeId: 'archetype-1',
        archetypeSuppressionWeight: 0.25,
        finding,
      },
    ]);
  });

  it('passes Findings through without learning metadata when assignment fails', async () => {
    const logger = new FakeLogger();
    const assigner = new FindingArchetypeAssigner(
      new ThrowingEmbedder(),
      new FakeArchetypeStore(),
      {
        logger,
      },
    );

    const stamped = await assigner.assignArchetypes([{ id: 'finding-1', finding }]);

    expect(stamped).toEqual([{ id: 'finding-1', archetypeSuppressionWeight: 0, finding }]);
    expect(logger.warnings).toEqual([
      [
        'Skipping Finding archetype assignment; posting review without learning metadata',
        expect.any(Error),
      ],
    ]);
  });
});

class FakeEmbedder {
  summaries: string[] = [];

  async embedFindingSummary(summary: string): Promise<number[]> {
    this.summaries.push(summary);
    return [0.1, 0.2, 0.3];
  }
}

class ThrowingEmbedder {
  async embedFindingSummary(): Promise<number[]> {
    throw new Error('Ollama embedding request failed: connect ECONNREFUSED 127.0.0.1:11434');
  }
}

class FakeArchetypeStore {
  assignments: Array<{ findingId: string; embedding: number[] }> = [];

  async assignArchetype(input: {
    findingId: string;
    embedding: number[];
  }): Promise<{ archetypeId: string; suppressionWeight: number }> {
    this.assignments.push(input);
    return { archetypeId: `archetype-${this.assignments.length}`, suppressionWeight: 0.25 };
  }
}

class FakeLogger {
  readonly warnings: unknown[][] = [];

  warn(...args: unknown[]): void {
    this.warnings.push(args);
  }
}
