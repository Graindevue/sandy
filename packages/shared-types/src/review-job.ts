import type { AgentRunId } from './agent.js';
import type { Confidence } from './finding.js';
import type { PullRequestId } from './pull-request.js';
import type { RepoId } from './repo.js';

/** Stable identifier for a ReviewJob (a Convex document id at runtime). */
export type ReviewJobId = string;

/** ReviewJob status flow: `pending → running → (completed | failed | superseded)`. */
export type ReviewJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'superseded';

/** What caused a Review to be triggered. */
export type ReviewTrigger = 'mention' | 'ready' | 'push' | 'opened';

/**
 * A queued unit of review work in Convex. One ReviewJob per Review attempt;
 * multiple may exist for the same PR over time as iteration happens.
 */
export interface ReviewJob {
  id: ReviewJobId;
  pullRequestId: PullRequestId;
  repoId: RepoId;
  /** Head SHA this job reviews. */
  headSha: string;
  status: ReviewJobStatus;
  /** Why this Review was triggered. */
  trigger: ReviewTrigger;
  /** Agent keys this job runs. Phase 1: always `["logic"]`. */
  agentKeys: string[];
  /** PR-level confidence score computed from the synthesized Findings. */
  confidenceScore: Confidence;
  /** AgentRun ids produced while executing this ReviewJob. */
  agentRuns: AgentRunId[];
  /** Sibling Repo full names mapped to their pinned default-branch SHA. */
  siblingShas: Record<string, string>;
  /** Epoch milliseconds when the job was enqueued. */
  createdAt: number;
  /** Epoch milliseconds when a worker claimed the job, if claimed. */
  claimedAt?: number;
  /** Epoch milliseconds when the job reached a terminal status, if it has. */
  finishedAt?: number;
  /** Failure reason when `status === 'failed'`. */
  error?: string;
}
