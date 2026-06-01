import type { ArchetypeAssignedFinding, PersistedFinding } from '../worker/review-findings.js';

export interface FindingSummaryEmbedder {
  embedFindingSummary(summary: string): Promise<number[]>;
}

export interface ArchetypeAssignmentStore {
  assignArchetype(input: {
    findingId: string;
    embedding: number[];
  }): Promise<{ archetypeId: string; suppressionWeight: number }>;
}

export interface FindingArchetypeAssignerLogger {
  warn(message: string, ...args: unknown[]): void;
}

const defaultLogger: FindingArchetypeAssignerLogger = console;

export class FindingArchetypeAssigner {
  readonly #embedder: FindingSummaryEmbedder;
  readonly #store: ArchetypeAssignmentStore;
  readonly #logger: FindingArchetypeAssignerLogger;

  constructor(
    embedder: FindingSummaryEmbedder,
    store: ArchetypeAssignmentStore,
    options: { logger?: FindingArchetypeAssignerLogger } = {},
  ) {
    this.#embedder = embedder;
    this.#store = store;
    this.#logger = options.logger ?? defaultLogger;
  }

  async assignArchetypes(
    findings: readonly PersistedFinding[],
  ): Promise<ArchetypeAssignedFinding[]> {
    try {
      return await this.#assignAllArchetypes(findings);
    } catch (error) {
      this.#logger.warn(
        'Skipping Finding archetype assignment; posting review without learning metadata',
        error,
      );
      return findings.map((finding) => ({ ...finding, archetypeSuppressionWeight: 0 }));
    }
  }

  async #assignAllArchetypes(
    findings: readonly PersistedFinding[],
  ): Promise<ArchetypeAssignedFinding[]> {
    const stamped: ArchetypeAssignedFinding[] = [];

    for (const persisted of findings) {
      const embedding = await this.#embedder.embedFindingSummary(persisted.finding.summary);
      const { archetypeId, suppressionWeight } = await this.#store.assignArchetype({
        findingId: persisted.id,
        embedding,
      });
      stamped.push({ ...persisted, archetypeId, archetypeSuppressionWeight: suppressionWeight });
    }

    return stamped;
  }
}
