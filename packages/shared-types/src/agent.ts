import type { CrossRepoSearchRationale } from './finding.js';
import type { ReviewJobId } from './review-job.js';

/** Runtime vendor metadata; the GitHub Actions runner supports Codex only. */
export type AgentVendor = 'claude' | 'codex' | 'cursor' | 'copilot';

/**
 * Reasoning effort passed to the configured vendor CLI. The union covers
 * every vendor's vocabulary; which levels a given vendor accepts is a
 * vendor-scoped subset, validated at config load against the per-vendor
 * tables in the bot-worker config layer.
 */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Whether an Agent runs by default. `true`/`false` are explicit; `'auto'` lets
 * Sandy decide per Product (e.g. enable the `convex` Agent only when the Repo
 * uses Convex). The shipped Agent files declare this in their frontmatter.
 */
export type AgentDefaultEnabled = boolean | 'auto';

/**
 * A reviewer persona: a system prompt plus a vendor/model selection and a
 * completion signal. Sourced from a markdown file in `agents/`
 * (defaults) or `.config/agents/` (per-instance). Agents are configuration
 * data, not code — adding one requires no changes to Sandy.
 *
 * Built by the config loader from an Agent file's YAML frontmatter (the metadata
 * fields) plus its markdown body (`systemPrompt`).
 */
export interface AgentDefinition {
  /** Stable key derived from the definition's file name, e.g. `"logic"`. */
  key: string;
  /** Human-readable name (frontmatter `name`). */
  name: string;
  /** One-line summary of what the Agent reviews (frontmatter `description`). */
  description: string;
  /** Default Finding category this Agent emits; defaults to {@link key}. */
  category: string;
  vendor: AgentVendor;
  /** Vendor-specific model identifier, e.g. `"opus"`. */
  model: string;
  /**
   * Reasoning effort for the vendor CLI (frontmatter `effort`). Absent means
   * the vendor CLI's own default applies — exactly the pre-effort behavior.
   */
  effort?: AgentEffort;
  /** Deprecated configuration metadata; native Codex tools are not filtered by this list. */
  tools?: string[];
  /** Deprecated configuration metadata; the runner performs one turn and at most one resume. */
  maxIterations?: number;
  /** String whose appearance in Agent output marks the run complete. */
  completionSignal: string;
  /** Whether this Agent runs by default (frontmatter `defaultEnabled`). */
  defaultEnabled: AgentDefaultEnabled;
  /** The Agent's system prompt (the markdown body of its definition file). */
  systemPrompt: string;
}

/** Stable identifier for an AgentRun (a Convex document id at runtime). */
export type AgentRunId = string;

/** Status of a single Agent's execution within a Review. */
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'timed_out';

/** Token usage reported for one AgentRun. */
export interface AgentRunUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

/** A record of one Agent executing within a Review. */
export interface AgentRun {
  id: AgentRunId;
  reviewJobId: ReviewJobId;
  /** Key of the Agent that ran. */
  agentKey: string;
  status: AgentRunStatus;
  /** Epoch milliseconds when the Agent started. */
  startedAt: number;
  /** Epoch milliseconds when the Agent finished, if it has. */
  finishedAt?: number;
  /** Number of Findings this run produced. */
  findingCount: number;
  /** Agent-reported Cross-Repo Search trigger/skip rationale for this run. */
  crossRepoSearch?: CrossRepoSearchRationale;
  /** Aggregated token usage reported by the Agent runtime, when available. */
  usage?: AgentRunUsage;
  /** Failure reason when `status === 'failed'`. */
  error?: string;
}
