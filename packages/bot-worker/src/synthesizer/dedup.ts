import type { Finding } from '@sandy/shared-types';

export const DEFAULT_SUMMARY_COSINE_THRESHOLD = 0.85;
export const DEFAULT_LINE_PROXIMITY = 2;
// Cross-agent merge thresholds. Margins are thin: a true merge can share as
// little as a quarter of its identifiers, while a distinct finding on the same
// lines can share just under that. dedup.test.ts pins both boundaries.
export const DEFAULT_CROSS_AGENT_ANCHOR_CONTAINMENT = 0.5;
export const DEFAULT_CROSS_AGENT_IDENTIFIER_OVERLAP = 0.25;

// Code identifiers: camelCase, PascalCase, snake_case, file names and
// namespaced references such as `errors:not_found`.
const IDENTIFIER_PATTERN =
  /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+|[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs)|[a-z]+:[a-z0-9_]+)\b/g;
const IGNORED_IDENTIFIERS = new Set(['node_modules']);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

const SEVERITY_RANK = {
  P0: 3,
  P1: 2,
  P2: 1,
} as const satisfies Record<Finding['severity'], number>;

export interface DedupFindingsOptions {
  summaryCosineThreshold?: number;
  lineProximity?: number;
  crossAgentAnchorContainment?: number;
  crossAgentIdentifierOverlap?: number;
}

interface Candidate {
  finding: Finding;
  index: number;
}

export function dedupeFindings(
  findings: readonly Finding[],
  options: DedupFindingsOptions = {},
): Finding[] {
  const dedupOptions = {
    summaryCosineThreshold: options.summaryCosineThreshold ?? DEFAULT_SUMMARY_COSINE_THRESHOLD,
    lineProximity: options.lineProximity ?? DEFAULT_LINE_PROXIMITY,
    crossAgentAnchorContainment:
      options.crossAgentAnchorContainment ?? DEFAULT_CROSS_AGENT_ANCHOR_CONTAINMENT,
    crossAgentIdentifierOverlap:
      options.crossAgentIdentifierOverlap ?? DEFAULT_CROSS_AGENT_IDENTIFIER_OVERLAP,
  };
  const clusters: Candidate[][] = [];

  for (const [index, finding] of findings.entries()) {
    const candidate = { finding, index };
    // The same wording on nearby lines is one defect, so it chains: lines 22,
    // 24 and 26 form one cluster and bridge clusters they touch.
    const lexicalClusters = clusters.filter((cluster) =>
      cluster.some((member) => isLexicalDuplicate(member.finding, finding, dedupOptions)),
    );
    const firstCluster = lexicalClusters[0];
    if (firstCluster !== undefined) {
      firstCluster.push(candidate);
      for (const cluster of lexicalClusters.slice(1).reverse()) {
        firstCluster.push(...cluster);
        clusters.splice(clusters.indexOf(cluster), 1);
      }
      continue;
    }

    // A cross-agent match must hold against every member, so A~B and B~C
    // cannot pull two unrelated findings A and C into one comment.
    const crossAgentCluster = clusters.find((cluster) =>
      cluster.every((member) => isCrossAgentDuplicate(member.finding, finding, dedupOptions)),
    );
    if (crossAgentCluster === undefined) {
      clusters.push([candidate]);
    } else {
      crossAgentCluster.push(candidate);
    }
  }

  return clusters
    .map((cluster) => creditMergedAgents(selectClusterRepresentative(cluster), cluster))
    .sort(compareFindingsForPosting)
    .map((candidate) => candidate.finding);
}

function creditMergedAgents(representative: Candidate, cluster: readonly Candidate[]): Candidate {
  const otherAgents = [
    ...new Set(
      cluster
        .flatMap(({ finding }) => [finding.agentKey, ...(finding.alsoReportedBy ?? [])])
        .filter((agentKey) => agentKey !== representative.finding.agentKey),
    ),
  ];
  if (otherAgents.length === 0) {
    return representative;
  }
  return {
    ...representative,
    finding: { ...representative.finding, alsoReportedBy: otherAgents },
  };
}

export function summaryCosineSimilarity(left: string, right: string): number {
  const leftVector = vectorizeSummary(left);
  const rightVector = vectorizeSummary(right);
  if (leftVector.size === 0 || rightVector.size === 0) {
    return normalizeText(left) === normalizeText(right) ? 1 : 0;
  }

  let dotProduct = 0;
  for (const [term, leftWeight] of leftVector) {
    dotProduct += leftWeight * (rightVector.get(term) ?? 0);
  }

  return dotProduct / (magnitude(leftVector) * magnitude(rightVector));
}

function isLexicalDuplicate(
  left: Finding,
  right: Finding,
  options: Required<DedupFindingsOptions>,
): boolean {
  return (
    isNearbySamePath(left, right, options.lineProximity) &&
    summaryCosineSimilarity(left.summary, right.summary) >= options.summaryCosineThreshold
  );
}

function isCrossAgentDuplicate(
  left: Finding,
  right: Finding,
  options: Required<DedupFindingsOptions>,
): boolean {
  // Different Agents describe the same defect in different words, so summary
  // wording is a poor signal. Require largely shared anchors and shared code
  // identifiers across summary, evidence and fix instead.
  return (
    left.agentKey !== right.agentKey &&
    anchorContainment(left, right) > options.crossAgentAnchorContainment &&
    identifierOverlap(left, right) >= options.crossAgentIdentifierOverlap
  );
}

/** Overlapping lines divided by the length of the shorter anchor range. */
function anchorContainment(left: Finding, right: Finding): number {
  if (left.anchor.repo !== right.anchor.repo || left.anchor.path !== right.anchor.path) {
    return 0;
  }
  const overlap =
    Math.min(left.anchor.lineEnd, right.anchor.lineEnd) -
    Math.max(left.anchor.lineStart, right.anchor.lineStart) +
    1;
  const shorter = Math.min(
    left.anchor.lineEnd - left.anchor.lineStart + 1,
    right.anchor.lineEnd - right.anchor.lineStart + 1,
  );
  return Math.max(0, overlap) / shorter;
}

/** Shared code identifiers divided by the smaller identifier set. */
function identifierOverlap(left: Finding, right: Finding): number {
  const leftIdentifiers = codeIdentifiers(left);
  const rightIdentifiers = codeIdentifiers(right);
  const smaller = Math.min(leftIdentifiers.size, rightIdentifiers.size);
  if (smaller === 0) {
    return 0;
  }
  let shared = 0;
  for (const identifier of leftIdentifiers) {
    if (rightIdentifiers.has(identifier)) {
      shared += 1;
    }
  }
  return shared / smaller;
}

function codeIdentifiers(finding: Finding): Set<string> {
  const text = [finding.summary, finding.evidence, finding.suggestedFix ?? ''].join(' ');
  return new Set(
    [...text.matchAll(IDENTIFIER_PATTERN)]
      .map(([identifier]) => identifier.toLowerCase())
      .filter((identifier) => !IGNORED_IDENTIFIERS.has(identifier)),
  );
}

function isNearbySamePath(left: Finding, right: Finding, lineProximity: number): boolean {
  if (left.anchor.repo !== right.anchor.repo || left.anchor.path !== right.anchor.path) {
    return false;
  }
  return lineRangeGap(left.anchor, right.anchor) <= lineProximity;
}

function lineRangeGap(left: Finding['anchor'], right: Finding['anchor']): number {
  if (left.lineEnd < right.lineStart) {
    return right.lineStart - left.lineEnd;
  }
  if (right.lineEnd < left.lineStart) {
    return left.lineStart - right.lineEnd;
  }
  return 0;
}

function selectClusterRepresentative(cluster: readonly Candidate[]): Candidate {
  return cluster.reduce((best, candidate) =>
    compareFindingStrength(candidate, best) > 0 ? candidate : best,
  );
}

function compareFindingStrength(left: Candidate, right: Candidate): number {
  const severityDelta =
    SEVERITY_RANK[left.finding.severity] - SEVERITY_RANK[right.finding.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const confidenceDelta = left.finding.confidence - right.finding.confidence;
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const crossRepoDelta =
    (left.finding.crossRepoReferences?.length ?? 0) -
    (right.finding.crossRepoReferences?.length ?? 0);
  if (crossRepoDelta !== 0) {
    return crossRepoDelta;
  }

  return right.index - left.index;
}

function compareFindingsForPosting(left: Candidate, right: Candidate): number {
  const leftRisk = SEVERITY_RANK[left.finding.severity] * left.finding.confidence;
  const rightRisk = SEVERITY_RANK[right.finding.severity] * right.finding.confidence;
  if (leftRisk !== rightRisk) {
    return rightRisk - leftRisk;
  }

  return left.index - right.index;
}

function vectorizeSummary(summary: string): Map<string, number> {
  const vector = new Map<string, number>();
  for (const token of tokenize(summary)) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  return vector;
}

function tokenize(summary: string): string[] {
  return normalizeText(summary)
    .split(/\s+/)
    .map(stemToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && token.endsWith('ing')) {
    return token.slice(0, -3);
  }
  if (token.length > 3 && token.endsWith('ed')) {
    return token.slice(0, -2);
  }
  if (token.length > 4 && token.endsWith('es')) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s')) {
    return token.slice(0, -1);
  }
  return token;
}

function magnitude(vector: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const weight of vector.values()) {
    sum += weight ** 2;
  }
  return Math.sqrt(sum);
}
