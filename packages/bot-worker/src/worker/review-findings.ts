import type { Finding } from '@sandy/shared-types';

export interface PersistedFinding {
  id: string;
  finding: Finding;
}

export interface ArchetypeStampedFinding extends PersistedFinding {
  archetypeId?: string;
}

export interface ArchetypeAssignedFinding extends ArchetypeStampedFinding {
  archetypeSuppressionWeight: number;
}
