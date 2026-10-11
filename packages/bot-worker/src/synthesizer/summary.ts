import type { Confidence, CrossRepoSearchRationale, Finding } from '@sandy/shared-types';

export interface AgentCrossRepoSearchSummary {
  agentKey: string;
  crossRepoSearch: CrossRepoSearchRationale;
}

export interface AgentSummary {
  agentKey: string;
  summary?: string;
}

export interface BuildReviewSummaryInput {
  findings: readonly Finding[];
  rawFindingCount: number;
  changedLineCount: number;
  /** `null` when the Review is incomplete and therefore not scored. */
  confidenceScore: Confidence | null;
  /** One entry per Agent that completed, in selected order. */
  agentSummaries: readonly AgentSummary[];
  /** Selected Agents that failed; any entry makes the Review incomplete. */
  failedAgentKeys?: readonly string[];
  crossRepoSearches: readonly AgentCrossRepoSearchSummary[];
}

export function buildReviewSummary(input: BuildReviewSummaryInput): string {
  const parts = [buildScoreLine(input), buildHeadline(input)];
  const dedupSummary = buildDedupSummary(input.rawFindingCount, input.findings.length);
  if (dedupSummary !== null) {
    parts.push(dedupSummary);
  }

  const agentSummaries = formatAgentSummaries(input.agentSummaries, input.failedAgentKeys ?? []);
  if (agentSummaries.length > 0) {
    parts.push(`Agent summaries:\n${agentSummaries.join('\n')}`);
  }

  const crossRepoSearchSummaries = formatCrossRepoSearches(input.crossRepoSearches);
  if (crossRepoSearchSummaries.length > 0) {
    parts.push(`Cross-repo search:\n${crossRepoSearchSummaries.join('\n')}`);
  }

  if (input.findings.length > 0) {
    parts.push(
      `Top findings:\n${input.findings
        .slice(0, 5)
        .map((finding) => `- ${finding.severity} ${finding.category}: ${finding.summary}`)
        .join('\n')}`,
    );
  }

  return parts.join('\n\n');
}

const SEVERITIES = ['P0', 'P1', 'P2'] as const satisfies readonly Finding['severity'][];

function changedLines(count: number): string {
  return `${count.toLocaleString('en-US')} changed ${count === 1 ? 'line' : 'lines'}`;
}

function describeScoreInputs(findings: readonly Finding[], changedLineCount: number): string {
  const lines = changedLines(changedLineCount);
  if (findings.length === 0) {
    return `no findings across ${lines}`;
  }
  const counts = SEVERITIES.flatMap((severity) => {
    const count = findings.filter((finding) => finding.severity === severity).length;
    return count === 0 ? [] : [`${count} ${severity}`];
  });
  return `${counts.join(', ')} ${findings.length === 1 ? 'finding' : 'findings'} across ${lines}`;
}

function buildScoreLine(input: BuildReviewSummaryInput): string {
  if (input.confidenceScore === null) {
    return 'Confidence score: not scored (review incomplete)';
  }
  return `Confidence score: ${input.confidenceScore}/5 (5 = clean; ${describeScoreInputs(input.findings, input.changedLineCount)})`;
}

function buildHeadline(input: BuildReviewSummaryInput): string {
  const failedAgentKeys = input.failedAgentKeys ?? [];
  const completedAgentKeys = input.agentSummaries.map(({ agentKey }) => agentKey);
  if (failedAgentKeys.length > 0) {
    const selectedAgentCount = failedAgentKeys.length + completedAgentKeys.length;
    const remaining =
      completedAgentKeys.length === 0
        ? ''
        : ` Findings below come only from ${completedAgentKeys.join(', ')}.`;
    return `Review incomplete: ${failedAgentKeys.length} of ${selectedAgentCount} Agents failed (${failedAgentKeys.join(', ')}).${remaining}`;
  }

  const findingCount = input.findings.length;
  if (findingCount === 0) {
    const ran =
      completedAgentKeys.length === 0 ? '' : ` Agents that ran: ${completedAgentKeys.join(', ')};`;
    return `Sandy review found no issues.${ran} ${changedLines(input.changedLineCount)} reviewed.`;
  }

  const noun = findingCount === 1 ? 'finding' : 'findings';
  return `Sandy review posted ${findingCount} ${noun}.`;
}

function buildDedupSummary(rawFindingCount: number, findingCount: number): string | null {
  if (rawFindingCount === findingCount) {
    return null;
  }

  const postedNoun = findingCount === 1 ? 'finding' : 'findings';
  return `Synthesized ${rawFindingCount} raw findings into ${findingCount} posted ${postedNoun}.`;
}

function formatCrossRepoSearches(
  crossRepoSearches: readonly AgentCrossRepoSearchSummary[],
): string[] {
  return crossRepoSearches.map(({ agentKey, crossRepoSearch }) => {
    const repos =
      crossRepoSearch.searchedRepos === undefined || crossRepoSearch.searchedRepos.length === 0
        ? ''
        : ` Repos: ${crossRepoSearch.searchedRepos.join(', ')}.`;
    return `- ${agentKey}: ${crossRepoSearch.status} (${crossRepoSearch.trigger}) - ${crossRepoSearch.rationale}${repos}`;
  });
}

function formatAgentSummaries(
  agentSummaries: readonly AgentSummary[],
  failedAgentKeys: readonly string[],
): string[] {
  return [
    ...agentSummaries.map(({ agentKey, summary }) => {
      const text = summary?.trim() ?? '';
      return `- ${agentKey}: ${text.length === 0 ? '(no summary returned)' : text}`;
    }),
    ...failedAgentKeys.map((agentKey) => `- ${agentKey}: (failed; no findings returned)`),
  ];
}
