import type { ArchetypeStampedFinding, PersistedFinding } from '../worker/review-findings.js';

export interface FindingSummaryEmbedder {
  embedFindingSummary(summary: string): Promise<number[]>;
}

export interface ArchetypeAssignmentStore {
  assignArchetype(input: {
    findingId: string;
    embedding: number[];
  }): Promise<{ archetypeId: string }>;
}

export class FindingArchetypeAssigner {
  readonly #embedder: FindingSummaryEmbedder;
  readonly #store: ArchetypeAssignmentStore;

  constructor(embedder: FindingSummaryEmbedder, store: ArchetypeAssignmentStore) {
    this.#embedder = embedder;
    this.#store = store;
  }

  async assignArchetypes(
    findings: readonly PersistedFinding[],
  ): Promise<ArchetypeStampedFinding[]> {
    const stamped: ArchetypeStampedFinding[] = [];

    for (const persisted of findings) {
      const embedding = await this.#embedder.embedFindingSummary(persisted.finding.summary);
      const { archetypeId } = await this.#store.assignArchetype({
        findingId: persisted.id,
        embedding,
      });
      stamped.push({ ...persisted, archetypeId });
    }

    return stamped;
  }
}
