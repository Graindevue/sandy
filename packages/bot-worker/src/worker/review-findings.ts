import type { Finding } from '@sandy/shared-types';

export interface PersistedFinding {
  id: string;
  finding: Finding;
}

export interface ArchetypeStampedFinding extends PersistedFinding {
  archetypeId: string;
}

export interface UnassignedFinding extends PersistedFinding {
  archetypeId?: never;
}

export type ArchetypeAssignedFinding = (ArchetypeStampedFinding | UnassignedFinding) & {
  archetypeSuppressionWeight: number;
};

export type PostableFinding = ArchetypeStampedFinding | UnassignedFinding;
