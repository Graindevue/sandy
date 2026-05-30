import type {
  AgentRunStatus,
  Confidence,
  PullRequestState,
  ReviewJobStatus,
  ReviewTrigger,
  Severity,
} from '@sandy/shared-types';
import { v } from 'convex/values';

/**
 * Convex validators for the union types Sandy shares across packages. Each
 * literal is pinned to its `@sandy/shared-types` counterpart with `satisfies`,
 * so renaming or removing a shared union member fails compilation here. Adding a
 * new member is not caught — keep these validators in sync when a shared union
 * grows.
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

export const confidence = v.union(
  v.literal(0 satisfies Confidence),
  v.literal(1 satisfies Confidence),
  v.literal(2 satisfies Confidence),
  v.literal(3 satisfies Confidence),
  v.literal(4 satisfies Confidence),
  v.literal(5 satisfies Confidence),
);

export const agentRunStatus = v.union(
  v.literal('running' satisfies AgentRunStatus),
  v.literal('completed' satisfies AgentRunStatus),
  v.literal('failed' satisfies AgentRunStatus),
);

export const findingAnchor = v.object({
  repo: v.string(),
  path: v.string(),
  lineStart: v.number(),
  lineEnd: v.number(),
});

export const crossRepoReference = v.object({
  repo: v.string(),
  path: v.string(),
  line: v.number(),
});

export const siblingShas = v.record(v.string(), v.string());
