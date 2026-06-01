import type {
  ArchetypeAssignedFinding,
  ArchetypeStampedFinding,
} from '../worker/review-findings.js';

export const SUPPRESSION_WEIGHT_THRESHOLD = 0.7;

export function selectPostableFindings(
  findings: readonly ArchetypeAssignedFinding[],
): ArchetypeStampedFinding[] {
  const postable: ArchetypeStampedFinding[] = [];

  for (const { id, archetypeId, archetypeSuppressionWeight, finding } of findings) {
    if (archetypeSuppressionWeight < SUPPRESSION_WEIGHT_THRESHOLD) {
      postable.push({ id, archetypeId, finding });
    }
  }

  return postable;
}
