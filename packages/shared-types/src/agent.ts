import type { ReviewJobId } from './review-job.js';

/** The LLM vendor an Agent dispatches to via Sandcastle. */
export type AgentVendor = 'claude' | 'codex' | 'cursor' | 'copilot';

/**
 * A reviewer persona: a system prompt plus a vendor/model selection, a tool
 * allowlist, and a completion signal. Sourced from a markdown file in `agents/`
 * (defaults) or `.config/agents/` (per-instance). Agents are configuration
 * data, not code — adding one requires no changes to Sandy.
 */
export interface AgentDefinition {
  /** Stable key derived from the definition's file name, e.g. `"logic"`. */
  key: string;
  /** Human-readable name. */
  name: string;
  /** Default Finding category this Agent emits, e.g. `"logic"`. */
  category: string;
  vendor: AgentVendor;
  /** Vendor-specific model identifier, e.g. `"claude-opus-4-8"`. */
  model: string;
  /** Allowed tool names inside the Agent's sandbox. */
  tools: string[];
  /** The Agent's system prompt (the markdown body of its definition file). */
  systemPrompt: string;
}

/** Stable identifier for an AgentRun (a Convex document id at runtime). */
export type AgentRunId = string;

/** Status of a single Agent's execution within a Review. */
export type AgentRunStatus = 'running' | 'completed' | 'failed';

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
  /** Failure reason when `status === 'failed'`. */
  error?: string;
}
