import type { ArchetypeAssignedFinding, PersistedFinding } from '../worker/review-findings.js';

export interface FindingTextEmbedder {
  embedFindingText(text: string): Promise<number[]>;
}

/**
 * Text fed to the embedder for archetype clustering. We embed the finding's
 * `evidence`, not its `summary`: summaries vary by surface detail (e.g. the
 * specific route name) which scatters semantically-identical findings below the
 * similarity threshold, whereas the evidence describes the underlying mechanism
 * in shared vocabulary. Validated on real findings during the Phase 3.1
 * acceptance test (issue #41): embedding evidence gives a clean in-bucket
 * separation margin where summary (and even summary+evidence) do not. Falls
 * back to the summary if evidence is empty.
 */
export function archetypeEmbeddingInput(finding: { summary: string; evidence: string }): string {
  return finding.evidence.trim().length > 0 ? finding.evidence : finding.summary;
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
  readonly #embedder: FindingTextEmbedder;
  readonly #store: ArchetypeAssignmentStore;
  readonly #logger: FindingArchetypeAssignerLogger;

  constructor(
    embedder: FindingTextEmbedder,
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
      return withoutArchetypeMetadata(findings);
    }
  }

  async #assignAllArchetypes(
    findings: readonly PersistedFinding[],
  ): Promise<ArchetypeAssignedFinding[]> {
    const stamped: ArchetypeAssignedFinding[] = [];

    for (const persisted of findings) {
      const embedding = await this.#embedder.embedFindingText(
        archetypeEmbeddingInput(persisted.finding),
      );
      const { archetypeId, suppressionWeight } = await this.#store.assignArchetype({
        findingId: persisted.id,
        embedding,
      });
      stamped.push({ ...persisted, archetypeId, archetypeSuppressionWeight: suppressionWeight });
    }

    return stamped;
  }
}

export const disabledArchetypeAssigner = {
  async assignArchetypes(
    findings: readonly PersistedFinding[],
  ): Promise<ArchetypeAssignedFinding[]> {
    return withoutArchetypeMetadata(findings);
  },
};

function withoutArchetypeMetadata(
  findings: readonly PersistedFinding[],
): ArchetypeAssignedFinding[] {
  return findings.map((finding) => ({ ...finding, archetypeSuppressionWeight: 0 }));
}
