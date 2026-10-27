import type { AgentRunUsage } from '@sandy/shared-types';
import type { LocalAgentRun } from './adapters.js';
import type { LocalReviewFinding, LocalReviewResult, LocalReviewStatus } from './history.js';

const STATUS_LABELS: Record<LocalReviewStatus, string> = {
  completed: 'completed',
  incomplete: 'incomplete: some reviewers failed, so the Review is not scored',
  failed: 'failed',
  declined: 'declined: the diff is too large to review',
  no_changes: 'nothing to review',
};

export function renderJson(review: LocalReviewResult): string {
  return `${JSON.stringify(review, null, 2)}\n`;
}

/** Plain text for terminals and coding agents; no colors or cursor control. */
export function renderText(review: LocalReviewResult): string {
  const sections = [
    [
      `Sandy review ${review.id}: ${STATUS_LABELS[review.status]}`,
      `${review.repository} ${review.branch ?? 'detached HEAD'} at ${short(review.head)} vs ${review.base.ref} at ${short(review.base.sha)} (merge base ${short(review.base.mergeBase)})`,
      overviewLine(review),
    ].join('\n'),
  ];
  if (review.error !== undefined) sections.push(`Error: ${review.error}`);
  if (review.findings.length > 0) {
    sections.push(
      review.findings
        .map((finding, index) => renderFinding(finding, index, review.repository))
        .join('\n\n'),
    );
  }
  if (review.agents.length > 0) {
    sections.push(['Reviewers:', ...review.agents.map((agent) => renderAgent(agent))].join('\n'));
  }
  if (review.summary.trim() !== '') sections.push(`Summary:\n${review.summary.trim()}`);
  if (review.warnings.length > 0) {
    sections.push(['Warnings:', ...review.warnings.map((warning) => `- ${warning}`)].join('\n'));
  }
  if (review.status !== 'no_changes') {
    sections.push(`Show this Review again with: sandy review show ${review.id}`);
  }
  return `${sections.join('\n\n')}\n`;
}

export function renderList(reviews: readonly LocalReviewResult[]): string {
  if (reviews.length === 0) return 'No saved Reviews.\n';
  const rows = [
    ['ID', 'STATUS', 'SCORE', 'FINDINGS', 'REPOSITORY', 'BRANCH', 'FINISHED'],
    ...reviews.map((review) => [
      review.id,
      review.status,
      review.confidenceScore === null ? '-' : `${review.confidenceScore}/5`,
      String(review.findings.length),
      review.repository,
      review.branch ?? 'detached HEAD',
      review.finishedAt.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC'),
    ]),
  ];
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );
  return `${rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
        )
        .join('  '),
    )
    .join('\n')}\n`;
}

/** One line per saved Review for `sandy review list --json`. */
export function listEntry(review: LocalReviewResult) {
  return {
    id: review.id,
    status: review.status,
    repository: review.repository,
    branch: review.branch,
    head: review.head,
    confidenceScore: review.confidenceScore,
    findingCount: review.findings.length,
    finishedAt: review.finishedAt,
  };
}

function overviewLine(review: LocalReviewResult): string {
  const score =
    review.confidenceScore === null
      ? 'Confidence score: not scored'
      : `Confidence score: ${review.confidenceScore}/5 (5 = clean)`;
  const parts = [score];
  if (review.changedLines !== null) parts.push(plural(review.changedLines, 'changed line'));
  parts.push(plural(review.findings.length, 'finding'));
  return parts.join(' · ');
}

function renderFinding(finding: LocalReviewFinding, index: number, repository: string): string {
  const lines =
    finding.lineStart === finding.lineEnd
      ? `${finding.lineStart}`
      : `${finding.lineStart}-${finding.lineEnd}`;
  const location = `${finding.repo.toLowerCase() === repository.toLowerCase() ? '' : `${finding.repo}/`}${finding.path}:${lines}`;
  const parts = [
    `${index + 1}. [${finding.severity}] ${finding.category} · ${location} · confidence ${finding.confidence}/5 · ${finding.agentKey}`,
    indent(finding.summary, 3),
    `   Evidence:\n${indent(finding.evidence, 5)}`,
  ];
  if (finding.suggestedFix !== undefined) {
    parts.push(`   Possible direction (unverified):\n${indent(finding.suggestedFix, 5)}`);
  }
  if (finding.alsoReportedBy !== undefined && finding.alsoReportedBy.length > 0) {
    parts.push(`   Also reported by: ${finding.alsoReportedBy.join(', ')}`);
  }
  if (finding.crossRepoReferences !== undefined && finding.crossRepoReferences.length > 0) {
    parts.push(
      `   Cross-repo references:\n${finding.crossRepoReferences
        .map((reference) => `     - ${reference.repo}/${reference.path}:${reference.line}`)
        .join('\n')}`,
    );
  }
  return parts.join('\n');
}

function renderAgent(agent: LocalAgentRun): string {
  const parts = [`- ${agent.key}: ${agent.status.replace('_', ' ')}`];
  if (agent.status === 'completed') parts.push(plural(agent.findingCount, 'finding'));
  parts.push(duration(agent.durationMs));
  if (agent.usage !== undefined) parts.push(usage(agent.usage));
  const line = parts.join(', ');
  return agent.error === undefined ? line : `${line}\n${indent(agent.error, 4)}`;
}

function usage(counts: AgentRunUsage): string {
  const input = counts.inputTokens + counts.cacheCreationInputTokens;
  return `${number(input)} input + ${number(counts.cacheReadInputTokens)} cached + ${number(counts.outputTokens)} output tokens`;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function plural(count: number, noun: string): string {
  return `${number(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function number(value: number): string {
  return value.toLocaleString('en-US');
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .trim()
    .split('\n')
    .map((line) => (line === '' ? '' : `${pad}${line}`))
    .join('\n');
}
