import type { Confidence, Finding, FindingsPayload } from '@sandy/shared-types';
import type {
  ArchetypeAssignedFinding,
  ArchetypeStampedFinding,
} from '../worker/review-findings.js';
import { type DedupFindingsOptions, dedupeFindings } from './dedup.js';
import { computeConfidenceScore } from './score.js';
import { type AgentCrossRepoSearchSummary, buildReviewSummary } from './summary.js';
import { selectPostableFindings } from './suppression-filter.js';

export interface AgentReviewOutput {
  agentKey: string;
  payload: FindingsPayload;
}

export interface SynthesizeReviewInput {
  findings: readonly Finding[];
  changedLineCount: number;
  agentSummaries: readonly string[];
  crossRepoSearches?: readonly AgentCrossRepoSearchSummary[];
  dedup?: DedupFindingsOptions;
}

export interface SynthesizeAgentOutputsInput {
  agentOutputs: readonly AgentReviewOutput[];
  changedLineCount: number;
  dedup?: DedupFindingsOptions;
}

export interface SynthesizePostableReviewInput {
  archetypeAssignedFindings: readonly ArchetypeAssignedFinding[];
  agentOutputs: readonly AgentReviewOutput[];
  changedLineCount: number;
  rawFindingCount: number;
}

export interface SynthesizedReview {
  findings: Finding[];
  confidenceScore: Confidence;
  summary: string;
  rawFindingCount: number;
}

export interface PostableReview {
  findings: ArchetypeStampedFinding[];
  summary: string;
}

export function synthesizeAgentOutputs(input: SynthesizeAgentOutputsInput): SynthesizedReview {
  const summaryContext = agentOutputSummaryContext(input.agentOutputs);
  const reviewInput: SynthesizeReviewInput = {
    changedLineCount: input.changedLineCount,
    agentSummaries: summaryContext.agentSummaries,
    crossRepoSearches: summaryContext.crossRepoSearches,
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
  const summary = summarizeFindings({
    findings,
    changedLineCount: input.changedLineCount,
    rawFindingCount: input.findings.length,
    agentSummaries: input.agentSummaries,
    crossRepoSearches: input.crossRepoSearches ?? [],
  });

  return {
    findings,
    confidenceScore: summary.confidenceScore,
    rawFindingCount: input.findings.length,
    summary: summary.text,
  };
}

export function synthesizePostableReview(input: SynthesizePostableReviewInput): PostableReview {
  const findings = selectPostableFindings(input.archetypeAssignedFindings);
  const summaryContext = agentOutputSummaryContext(input.agentOutputs);
  const summary = summarizeFindings({
    findings: findings.map(({ finding }) => finding),
    changedLineCount: input.changedLineCount,
    rawFindingCount: input.rawFindingCount,
    agentSummaries: summaryContext.agentSummaries,
    crossRepoSearches: summaryContext.crossRepoSearches,
  });

  return {
    findings,
    summary: summary.text,
  };
}

function summarizeFindings(input: {
  findings: readonly Finding[];
  changedLineCount: number;
  rawFindingCount: number;
  agentSummaries: readonly string[];
  crossRepoSearches: readonly AgentCrossRepoSearchSummary[];
}): { confidenceScore: Confidence; text: string } {
  const confidenceScore = computeConfidenceScore({
    findings: input.findings,
    changedLineCount: input.changedLineCount,
  });
  return {
    confidenceScore,
    text: buildReviewSummary({
      findings: input.findings,
      rawFindingCount: input.rawFindingCount,
      confidenceScore,
      agentSummaries: input.agentSummaries,
      crossRepoSearches: input.crossRepoSearches,
    }),
  };
}

function agentOutputSummaryContext(agentOutputs: readonly AgentReviewOutput[]): {
  agentSummaries: string[];
  crossRepoSearches: AgentCrossRepoSearchSummary[];
} {
  return {
    agentSummaries: agentOutputs.flatMap(({ payload }) =>
      payload.summary === undefined ? [] : [payload.summary],
    ),
    crossRepoSearches: agentOutputs.map(({ agentKey, payload }) => ({
      agentKey,
      crossRepoSearch: payload.crossRepoSearch,
    })),
  };
}
