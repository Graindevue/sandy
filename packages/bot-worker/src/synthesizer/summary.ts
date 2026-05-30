import type { Confidence, CrossRepoSearchRationale, Finding } from '@sandy/shared-types';

export interface AgentCrossRepoSearchSummary {
  agentKey: string;
  crossRepoSearch: CrossRepoSearchRationale;
}

export interface BuildReviewSummaryInput {
  findings: readonly Finding[];
  rawFindingCount: number;
  confidenceScore: Confidence;
  agentSummaries: readonly string[];
  crossRepoSearches: readonly AgentCrossRepoSearchSummary[];
}

export function buildReviewSummary(input: BuildReviewSummaryInput): string {
  const parts = [
    `Confidence score: ${input.confidenceScore}/5`,
    buildHeadline(input.findings.length),
  ];
  const dedupSummary = buildDedupSummary(input.rawFindingCount, input.findings.length);
  if (dedupSummary !== null) {
    parts.push(dedupSummary);
  }

  const agentSummaries = cleanAgentSummaries(input.agentSummaries);
  if (agentSummaries.length > 0) {
    parts.push(`Agent summaries:\n${agentSummaries.map((summary) => `- ${summary}`).join('\n')}`);
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

function buildHeadline(findingCount: number): string {
  if (findingCount === 0) {
    return 'Sandy review: no findings posted.';
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

function cleanAgentSummaries(agentSummaries: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const agentSummary of agentSummaries) {
    const summary = agentSummary.trim();
    if (summary.length === 0 || seen.has(summary)) {
      continue;
    }
    seen.add(summary);
    cleaned.push(summary);
  }

  return cleaned;
}
