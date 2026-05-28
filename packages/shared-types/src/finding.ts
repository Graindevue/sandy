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

/** Where in the Product a Finding points. */
export interface FindingLocation {
  /** `"owner/name"` of the Repo the Finding refers to. */
  repo: string;
  /** File path within the Repo. */
  path: string;
  /** First line of the affected range (1-based). */
  lineStart: number;
  /** Last line of the affected range (1-based, inclusive). */
  lineEnd: number;
}

/** A single issue raised by an Agent during a Review. */
export interface Finding {
  severity: Severity;
  confidence: Confidence;
  location: FindingLocation;
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
