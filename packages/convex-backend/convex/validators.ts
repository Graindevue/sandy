import type {
  AgentRunStatus,
  PullRequestState,
  ReviewJobStatus,
  ReviewTrigger,
  Severity,
} from '@sandy/shared-types';
import { v } from 'convex/values';

/**
 * Convex validators for the union types Sandy shares across packages. Each
 * literal is pinned to its `@sandy/shared-types` counterpart with `satisfies`,
 * so a change to a shared union surfaces here as a type error rather than
 * silently drifting from the persisted shape.
 */
export const reviewJobStatus = v.union(
  v.literal('pending' satisfies ReviewJobStatus),
  v.literal('running' satisfies ReviewJobStatus),
  v.literal('completed' satisfies ReviewJobStatus),
  v.literal('failed' satisfies ReviewJobStatus),
  v.literal('superseded' satisfies ReviewJobStatus),
);

export const reviewTrigger = v.union(
  v.literal('mention' satisfies ReviewTrigger),
  v.literal('ready' satisfies ReviewTrigger),
  v.literal('push' satisfies ReviewTrigger),
  v.literal('opened' satisfies ReviewTrigger),
);

export const pullRequestState = v.union(
  v.literal('open' satisfies PullRequestState),
  v.literal('closed' satisfies PullRequestState),
  v.literal('merged' satisfies PullRequestState),
);

export const severity = v.union(
  v.literal('P0' satisfies Severity),
  v.literal('P1' satisfies Severity),
  v.literal('P2' satisfies Severity),
);

export const agentRunStatus = v.union(
  v.literal('running' satisfies AgentRunStatus),
  v.literal('completed' satisfies AgentRunStatus),
  v.literal('failed' satisfies AgentRunStatus),
);
