import type { Confidence, Finding, FindingsPayload } from '@sandy/shared-types';
import { type DedupFindingsOptions, dedupeFindings } from './dedup.js';
import { computeConfidenceScore } from './score.js';
import { buildReviewSummary } from './summary.js';

export interface AgentReviewOutput {
  agentKey: string;
  payload: FindingsPayload;
}

export interface SynthesizeReviewInput {
  findings: readonly Finding[];
  changedLineCount: number;
  agentSummaries: readonly string[];
  dedup?: DedupFindingsOptions;
}

export interface SynthesizeAgentOutputsInput {
  agentOutputs: readonly AgentReviewOutput[];
  changedLineCount: number;
  dedup?: DedupFindingsOptions;
}

export interface SynthesizedReview {
  findings: Finding[];
  confidenceScore: Confidence;
  summary: string;
  rawFindingCount: number;
}

export function synthesizeAgentOutputs(input: SynthesizeAgentOutputsInput): SynthesizedReview {
  const reviewInput: SynthesizeReviewInput = {
    changedLineCount: input.changedLineCount,
    agentSummaries: input.agentOutputs.flatMap(({ payload }) =>
      payload.summary === undefined ? [] : [payload.summary],
    ),
    findings: input.agentOutputs.flatMap(({ agentKey, payload }) =>
      payload.findings.map((finding) => ({ ...finding, agentKey })),
    ),
  };
  if (input.dedup !== undefined) {
    reviewInput.dedup = input.dedup;
  }
  return synthesizeReview(reviewInput);
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
