/** Finding severity: P0 (critical), P1 (high), P2 (medium). */
export type Severity = 'P0' | 'P1' | 'P2';

/** Agent confidence in a Finding, 0 (lowest) to 5 (highest). */
export type Confidence = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Finding category. Known values align with the default Agent personas in
 * `agents/` (`logic`, `security`, `convex`, `nextjs`, `i18n`, `style`,
 * `test-coverage`); custom Agents may introduce others, so any string is valid.
 */
export type FindingCategory = string;

/**
 * Where the inline PR review comment attaches. Must be in the reviewed PR's
 * diff; cross-repo consumer locations belong in `crossRepoReferences`.
 */
export interface FindingAnchor {
  /** `"owner/name"` of the Repo the comment anchors to. */
  repo: string;
  /** File path within the Repo. */
  path: string;
  /** First line of the affected range (1-based). */
  lineStart: number;
  /** Last line of the affected range (1-based, inclusive). */
  lineEnd: number;
}

/** A confirmed affected sibling Repo consumer for a cross-repo Finding. */
export interface CrossRepoReference {
  /** `"owner/name"` of the sibling Repo. */
  repo: string;
  /** File path within the sibling Repo. */
  path: string;
  /** Referenced line in the sibling Repo at its recorded default-branch SHA. */
  line: number;
}

/** A single issue raised by an Agent during a Review. */
export interface Finding {
  severity: Severity;
  confidence: Confidence;
  /** Stable key of the Agent that produced this Finding. */
  agentKey: string;
  anchor: FindingAnchor;
  crossRepoReferences?: CrossRepoReference[];
  /** One-sentence description of the issue. */
  summary: string;
  /** Supporting code excerpts or `rg` results. */
  evidence: string;
  /** Optional suggested fix. */
  suggestedFix?: string;
  category: FindingCategory;
}

/**
 * The JSON block an Agent emits inside `<findings>…</findings>`. Parsed and
 * validated by the worker's findings-parser before any Finding is posted.
 */
export interface FindingsPayload {
  findings: Finding[];
  /** Optional one-paragraph summary the Agent may emit alongside its findings. */
  summary?: string;
}
