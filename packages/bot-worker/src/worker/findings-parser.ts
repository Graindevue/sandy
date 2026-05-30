import type {
  Confidence,
  CrossRepoSearchRationale,
  CrossRepoSearchStatus,
  CrossRepoSearchTrigger,
  Finding,
  FindingsPayload,
  Severity,
} from '@sandy/shared-types';

const FINDINGS_BLOCK = /<findings>\s*([\s\S]*?)\s*<\/findings>/gi;
const SEVERITIES = new Set<Severity>(['P0', 'P1', 'P2']);
const CONFIDENCES = new Set<Confidence>([0, 1, 2, 3, 4, 5]);
const CROSS_REPO_SEARCH_STATUSES = new Set<CrossRepoSearchStatus>(['searched', 'skipped']);
const CROSS_REPO_SEARCH_TRIGGERS = new Set<CrossRepoSearchTrigger>([
  'manifest',
  'diff-judgment',
  'none',
]);

/**
 * Extract and validate the structured payload an Agent emits. This intentionally
 * uses small runtime checks instead of trusting TypeScript types: the input is
 * model-generated text.
 */
export function parseFindingsPayload(stdout: string): FindingsPayload {
  const matches = [...stdout.matchAll(FINDINGS_BLOCK)];
  const match = matches.at(-1);
  if (match === undefined) {
    throw new Error('Agent output did not contain a <findings>...</findings> block');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? '');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent <findings> block is not valid JSON: ${detail}`);
  }

  return validatePayload(parsed);
}

function validatePayload(value: unknown): FindingsPayload {
  const object = requireObject(value, 'FindingsPayload');
  if (!Array.isArray(object.findings)) {
    throw new Error('FindingsPayload.findings must be an array');
  }

  const payload: FindingsPayload = {
    findings: object.findings.map((finding, index) => validateFinding(finding, index)),
    crossRepoSearch: validateCrossRepoSearch(
      object.crossRepoSearch,
      'FindingsPayload.crossRepoSearch',
    ),
  };

  if (object.summary !== undefined) {
    if (typeof object.summary !== 'string') {
      throw new Error('FindingsPayload.summary must be a string when provided');
    }
    payload.summary = object.summary;
  }

  return payload;
}

function validateCrossRepoSearch(value: unknown, where: string): CrossRepoSearchRationale {
  const object = requireObject(value, where);
  const status = requireCrossRepoSearchStatus(object.status, `${where}.status`);
  const trigger = requireCrossRepoSearchTrigger(object.trigger, `${where}.trigger`);
  const rationale = requireString(object.rationale, `${where}.rationale`);
  const result: CrossRepoSearchRationale = { status, trigger, rationale };

  if (status === 'skipped' && trigger !== 'none') {
    throw new Error(`${where}.trigger must be "none" when status is "skipped"`);
  }
  if (status === 'searched' && trigger === 'none') {
    throw new Error(`${where}.trigger must be "manifest" or "diff-judgment" when searched`);
  }
  if (object.searchedRepos !== undefined) {
    if (!Array.isArray(object.searchedRepos)) {
      throw new Error(`${where}.searchedRepos must be an array when provided`);
    }
    result.searchedRepos = object.searchedRepos.map((repo, index) =>
      requireString(repo, `${where}.searchedRepos[${index}]`),
    );
  }

  return result;
}

function validateFinding(value: unknown, index: number): Finding {
  const where = `findings[${index}]`;
  const object = requireObject(value, where);
  const anchor = validateAnchor(object.anchor, `${where}.anchor`);
  const crossRepoReferences = validateCrossRepoReferences(
    object.crossRepoReferences,
    `${where}.crossRepoReferences`,
  );

  const finding: Finding = {
    severity: requireSeverity(object.severity, `${where}.severity`),
    confidence: requireConfidence(object.confidence, `${where}.confidence`),
    agentKey: requireString(object.agentKey, `${where}.agentKey`),
    anchor,
    summary: requireString(object.summary, `${where}.summary`),
    evidence: requireString(object.evidence, `${where}.evidence`),
    category: requireString(object.category, `${where}.category`),
  };

  if (crossRepoReferences !== undefined) {
    finding.crossRepoReferences = crossRepoReferences;
  }

  if (object.suggestedFix !== undefined) {
    finding.suggestedFix = requireString(object.suggestedFix, `${where}.suggestedFix`);
  }

  return finding;
}

function validateAnchor(value: unknown, where: string): Finding['anchor'] {
  const object = requireObject(value, where);
  const lineStart = requirePositiveInteger(object.lineStart, `${where}.lineStart`);
  const lineEnd = requirePositiveInteger(object.lineEnd, `${where}.lineEnd`);
  if (lineEnd < lineStart) {
    throw new Error(`${where}.lineEnd must be greater than or equal to lineStart`);
  }

  return {
    repo: requireString(object.repo, `${where}.repo`),
    path: requireString(object.path, `${where}.path`),
    lineStart,
    lineEnd,
  };
}

function validateCrossRepoReferences(
  value: unknown,
  where: string,
): Finding['crossRepoReferences'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be an array when provided`);
  }
  return value.map((reference, index) => {
    const itemWhere = `${where}[${index}]`;
    const object = requireObject(reference, itemWhere);
    return {
      repo: requireString(object.repo, `${itemWhere}.repo`),
      path: requireString(object.path, `${itemWhere}.path`),
      line: requirePositiveInteger(object.line, `${itemWhere}.line`),
    };
  });
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${where} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where} must be a positive integer`);
  }
  return value;
}

function requireSeverity(value: unknown, where: string): Severity {
  if (!SEVERITIES.has(value as Severity)) {
    throw new Error(`${where} must be one of P0, P1, P2`);
  }
  return value as Severity;
}

function requireConfidence(value: unknown, where: string): Confidence {
  if (!CONFIDENCES.has(value as Confidence)) {
    throw new Error(`${where} must be an integer from 0 to 5`);
  }
  return value as Confidence;
}

function requireCrossRepoSearchStatus(value: unknown, where: string): CrossRepoSearchStatus {
  if (!CROSS_REPO_SEARCH_STATUSES.has(value as CrossRepoSearchStatus)) {
    throw new Error(`${where} must be one of searched, skipped`);
  }
  return value as CrossRepoSearchStatus;
}

function requireCrossRepoSearchTrigger(value: unknown, where: string): CrossRepoSearchTrigger {
  if (!CROSS_REPO_SEARCH_TRIGGERS.has(value as CrossRepoSearchTrigger)) {
    throw new Error(`${where} must be one of manifest, diff-judgment, none`);
  }
  return value as CrossRepoSearchTrigger;
}
