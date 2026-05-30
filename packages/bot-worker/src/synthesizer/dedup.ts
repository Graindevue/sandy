import type { Finding } from '@sandy/shared-types';

export const DEFAULT_SUMMARY_COSINE_THRESHOLD = 0.85;
export const DEFAULT_LINE_PROXIMITY = 2;

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
  };
  const clusters: Candidate[][] = [];

  for (const [index, finding] of findings.entries()) {
    const candidate = { finding, index };
    const matchingClusters = clusters.filter((cluster) =>
      cluster.some((member) => isDuplicateFinding(member.finding, finding, dedupOptions)),
    );

    const firstCluster = matchingClusters[0];
    if (firstCluster === undefined) {
      clusters.push([candidate]);
      continue;
    }

    firstCluster.push(candidate);
    for (const cluster of matchingClusters.slice(1).reverse()) {
      firstCluster.push(...cluster);
      clusters.splice(clusters.indexOf(cluster), 1);
    }
  }

  return clusters
    .map((cluster) => selectClusterRepresentative(cluster))
    .sort(compareFindingsForPosting)
    .map((candidate) => candidate.finding);
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

function isDuplicateFinding(
  left: Finding,
  right: Finding,
  options: Required<DedupFindingsOptions>,
): boolean {
  return (
    isNearbySamePath(left, right, options.lineProximity) &&
    summaryCosineSimilarity(left.summary, right.summary) >= options.summaryCosineThreshold
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
