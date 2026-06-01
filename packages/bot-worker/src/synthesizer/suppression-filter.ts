import type { ArchetypeAssignedFinding, PostableFinding } from '../worker/review-findings.js';

export const SUPPRESSION_WEIGHT_THRESHOLD = 0.7;

export function selectPostableFindings(
  findings: readonly ArchetypeAssignedFinding[],
): PostableFinding[] {
  const postable: PostableFinding[] = [];

  for (const assigned of findings) {
    if (assigned.archetypeSuppressionWeight < SUPPRESSION_WEIGHT_THRESHOLD) {
      postable.push(postableFinding(assigned));
    }
  }

  return postable;
}

function postableFinding(assigned: ArchetypeAssignedFinding): PostableFinding {
  if (assigned.archetypeId === undefined) {
    return { id: assigned.id, finding: assigned.finding };
  }
  return { id: assigned.id, archetypeId: assigned.archetypeId, finding: assigned.finding };
}
