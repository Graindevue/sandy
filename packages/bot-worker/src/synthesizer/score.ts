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
  if (input.findings.length === 0) {
    return 0;
  }

  const findingRisk = input.findings.reduce(
    (sum, finding) => sum + SEVERITY_WEIGHT[finding.severity] * finding.confidence,
    0,
  );
  const blastRadiusBonus =
    changedLineBonus(input.changedLineCount) + crossRepoReferenceBonus(input.findings);

  return toConfidence(Math.ceil(findingRisk / 6 + blastRadiusBonus));
}

function changedLineBonus(changedLineCount: number): number {
  if (changedLineCount >= 1000) {
    return 2;
  }
  if (changedLineCount >= 250) {
    return 1;
  }
  return 0;
}

function crossRepoReferenceBonus(findings: readonly Finding[]): number {
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
