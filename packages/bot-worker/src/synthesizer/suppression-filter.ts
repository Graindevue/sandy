import type {
  ArchetypeAssignedFinding,
  ArchetypeStampedFinding,
} from '../worker/review-findings.js';

export const SUPPRESSION_WEIGHT_THRESHOLD = 0.7;

export function filterSuppressedFindings(
  findings: readonly ArchetypeAssignedFinding[],
): ArchetypeAssignedFinding[] {
  return findings.filter(
    ({ archetypeSuppressionWeight }) => archetypeSuppressionWeight < SUPPRESSION_WEIGHT_THRESHOLD,
  );
}

export function stripSuppressionWeights(
  findings: readonly ArchetypeAssignedFinding[],
): ArchetypeStampedFinding[] {
  return findings.map(({ id, archetypeId, finding }) => ({ id, archetypeId, finding }));
}
