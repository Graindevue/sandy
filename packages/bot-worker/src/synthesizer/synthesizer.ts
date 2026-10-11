import type { Confidence, Finding, FindingsPayload } from '@sandy/shared-types';
import type { ArchetypeAssignedFinding, PostableFinding } from '../worker/review-findings.js';
import { type DedupFindingsOptions, dedupeFindings } from './dedup.js';
import { computeConfidenceScore } from './score.js';
import {
  type AgentCrossRepoSearchSummary,
  type AgentSummary,
  buildReviewSummary,
} from './summary.js';
import { selectPostableFindings } from './suppression-filter.js';

export interface AgentReviewOutput {
  agentKey: string;
  payload: FindingsPayload;
}

export interface SynthesizeReviewInput {
  findings: readonly Finding[];
  changedLineCount: number;
  agentSummaries: readonly AgentSummary[];
  /** Selected Agents that failed; any entry leaves the Review unscored. */
  failedAgentKeys?: readonly string[];
  crossRepoSearches?: readonly AgentCrossRepoSearchSummary[];
  dedup?: DedupFindingsOptions;
}

export interface SynthesizeAgentOutputsInput {
  agentOutputs: readonly AgentReviewOutput[];
  failedAgentKeys?: readonly string[];
  changedLineCount: number;
  dedup?: DedupFindingsOptions;
}

export interface SynthesizePostableReviewInput {
  archetypeAssignedFindings: readonly ArchetypeAssignedFinding[];
  agentOutputs: readonly AgentReviewOutput[];
  failedAgentKeys?: readonly string[];
  changedLineCount: number;
  rawFindingCount: number;
}

export interface SynthesizedReview {
  findings: Finding[];
  /** `null` when a selected Agent failed: a partial Review is not scored. */
  confidenceScore: Confidence | null;
  summary: string;
  rawFindingCount: number;
}

export interface PostableReview {
  findings: PostableFinding[];
  summary: string;
}

export function synthesizeAgentOutputs(input: SynthesizeAgentOutputsInput): SynthesizedReview {
  const summaryContext = agentOutputSummaryContext(input.agentOutputs);
  const reviewInput: SynthesizeReviewInput = {
    changedLineCount: input.changedLineCount,
    agentSummaries: summaryContext.agentSummaries,
    failedAgentKeys: input.failedAgentKeys ?? [],
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
    failedAgentKeys: input.failedAgentKeys ?? [],
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
    failedAgentKeys: input.failedAgentKeys ?? [],
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
  agentSummaries: readonly AgentSummary[];
  failedAgentKeys: readonly string[];
  crossRepoSearches: readonly AgentCrossRepoSearchSummary[];
}): { confidenceScore: Confidence | null; text: string } {
  const confidenceScore =
    input.failedAgentKeys.length > 0 ? null : computeConfidenceScore({ findings: input.findings });
  return {
    confidenceScore,
    text: buildReviewSummary({
      findings: input.findings,
      rawFindingCount: input.rawFindingCount,
      changedLineCount: input.changedLineCount,
      confidenceScore,
      agentSummaries: input.agentSummaries,
      failedAgentKeys: input.failedAgentKeys,
      crossRepoSearches: input.crossRepoSearches,
    }),
  };
}

function agentOutputSummaryContext(agentOutputs: readonly AgentReviewOutput[]): {
  agentSummaries: AgentSummary[];
  crossRepoSearches: AgentCrossRepoSearchSummary[];
} {
  return {
    agentSummaries: agentOutputs.map(({ agentKey, payload }) =>
      payload.summary === undefined ? { agentKey } : { agentKey, summary: payload.summary },
    ),
    crossRepoSearches: agentOutputs.map(({ agentKey, payload }) => ({
      agentKey,
      crossRepoSearch: payload.crossRepoSearch,
    })),
  };
}
