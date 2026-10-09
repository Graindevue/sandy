import type { Confidence, Finding } from '@sandy/shared-types';

const SEVERITY_WEIGHT = {
  P0: 5,
  P1: 3,
  P2: 1,
} as const satisfies Record<Finding['severity'], number>;

export interface ComputeConfidenceScoreInput {
  findings: readonly Finding[];
  changedLineCount: number;
}

export function computeConfidenceScore(input: ComputeConfidenceScoreInput): Confidence {
  // Confidence Score: 5 = clean / most confidence the code is good, 0 = many
  // severe findings. We compute the existing risk total, then subtract it from 5.
  // Do not re-align this with per-Finding `confidence`, which runs the opposite
  // direction (higher = more sure a finding is a real problem). See CONTEXT.md.
  if (input.findings.length === 0) {
    return 5;
  }

  const findingRisk = input.findings.reduce(
    (sum, finding) => sum + SEVERITY_WEIGHT[finding.severity] * finding.confidence,
    0,
  );
  const blastRadiusPenalty =
    changedLinePenalty(input.changedLineCount) + crossRepoReferencePenalty(input.findings);

  return toConfidence(5 - Math.ceil(findingRisk / 6 + blastRadiusPenalty));
}

function changedLinePenalty(changedLineCount: number): number {
  if (changedLineCount >= 1000) {
    return 2;
  }
  if (changedLineCount >= 250) {
    return 1;
  }
  return 0;
}

function crossRepoReferencePenalty(findings: readonly Finding[]): number {
  const referenceCount = findings.reduce(
    (sum, finding) => sum + (finding.crossRepoReferences?.length ?? 0),
    0,
  );
  if (referenceCount >= 10) {
    return 2;
  }
  if (referenceCount > 0) {
    return 1;
  }
  return 0;
}

function toConfidence(value: number): Confidence {
  return Math.max(0, Math.min(5, value)) as Confidence;
}
