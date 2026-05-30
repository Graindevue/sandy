import type { Confidence, Finding } from '@sandy/shared-types';
import { type DedupFindingsOptions, dedupeFindings } from './dedup.js';
import { computeConfidenceScore } from './score.js';
import { buildReviewSummary } from './summary.js';

export interface SynthesizeReviewInput {
  findings: readonly Finding[];
  changedLineCount: number;
  agentSummaries: readonly string[];
  dedup?: DedupFindingsOptions;
}

export interface SynthesizedReview {
  findings: Finding[];
  confidenceScore: Confidence;
  summary: string;
  rawFindingCount: number;
}

export function synthesizeReview(input: SynthesizeReviewInput): SynthesizedReview {
  const findings = dedupeFindings(input.findings, input.dedup);
  const confidenceScore = computeConfidenceScore({
    findings,
    changedLineCount: input.changedLineCount,
  });

  return {
    findings,
    confidenceScore,
    rawFindingCount: input.findings.length,
    summary: buildReviewSummary({
      findings,
      rawFindingCount: input.findings.length,
      confidenceScore,
      agentSummaries: input.agentSummaries,
    }),
  };
}
