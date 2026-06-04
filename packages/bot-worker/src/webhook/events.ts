/**
 * Normalized webhook events. The raw GitHub payloads are large and loosely
 * typed; {@link parseEvent} narrows each supported delivery into one of these
 * shapes so the trigger-evaluator can stay a small, pure function over a
 * stable contract.
 */

import type { PullRequestState } from '@sandy/shared-types';

/** The GitHub webhook event names Sandy subscribes to (the `X-GitHub-Event` header). */
export const SUPPORTED_EVENT_NAMES = [
  'pull_request',
  'issue_comment',
  'pull_request_review_comment',
  'push',
  'check_run',
] as const;

export type SupportedEventName = (typeof SUPPORTED_EVENT_NAMES)[number];

const SUPPORTED_EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_EVENT_NAMES);

/** Whether a string is one of the webhook events Sandy subscribes to. */
export function isSupportedEvent(eventName: string | undefined): eventName is SupportedEventName {
  return eventName !== undefined && SUPPORTED_EVENT_NAME_SET.has(eventName);
}

export type GitHubCommentKind = 'pull_request_review_comment' | 'issue_comment';

/** Identity of the GitHub repository an event targets. */
export interface RepoRef {
  /** Owner or org login, e.g. `"tony-co"`. */
  owner: string;
  /** Repository name, e.g. `"sandy"`. */
  name: string;
}

/** The slice of PR state the evaluator and Convex upsert both need. */
export interface PullRequestFacts {
  number: number;
  draft: boolean;
  headSha: string;
  baseRef: string;
  title: string;
  author: string;
  url: string;
  /**
   * Lifecycle state of the PR, derived from GitHub's `pull_request.state` and
   * `pull_request.merged`. Closed or merged PRs are dead and must not be
   * re-armed by a late `@bot review` mention (Sticky Opt-In).
   */
  state: PullRequestState;
  /**
   * Repo the PR's head branch lives in, or `null` when GitHub could not resolve
   * it (e.g. the source fork was deleted, so `pull_request.head.repo` is null).
   * Differs from the base Repo for a fork PR, which v1 declines (PRD open
   * question); an unknown head Repo is likewise declined rather than guessed.
   */
  headRepo: RepoRef | null;
}

/**
 * `pull_request` delivery. `action` is narrowed to the subset that affects
 * Sticky Opt-In; everything else parses to `action: 'other'` and is ignored.
 */
export interface PullRequestEvent {
  kind: 'pull_request';
  action: 'opened' | 'synchronize' | 'ready_for_review' | 'closed' | 'reopened' | 'other';
  repo: RepoRef;
  pr: PullRequestFacts;
}

/**
 * `issue_comment` or `pull_request_review_comment` delivery on a PR. Both can
 * carry an `@bot review` mention, so they normalize to the same shape.
 */
export interface CommentEvent {
  kind: 'comment';
  repo: RepoRef;
  /** GitHub source for the comment delivery. */
  commentKind: GitHubCommentKind;
  /** GitHub comment id for the created comment, when present in the delivery. */
  githubCommentId?: number;
  /** Parent GitHub review-comment id when this comment is a threaded reply. */
  inReplyToId?: number;
  /** Raw comment body, scanned for the `@bot review` mention. */
  body: string;
  pr: PullRequestFacts;
}

/** `push` delivery to a branch that maps to an open PR. */
export interface PushEvent {
  kind: 'push';
  repo: RepoRef;
  pr: PullRequestFacts;
}

/** `check_run.rerequested` delivery for Sandy's advisory Review Status Check. */
export interface CheckRunEvent {
  kind: 'check_run';
  repo: RepoRef;
  pr: PullRequestFacts;
}

/** A webhook delivery Sandy understands but that carries no review signal. */
export interface IgnoredEvent {
  kind: 'ignored';
  reason: string;
}

/** Any normalized webhook event. */
export type ParsedEvent =
  | PullRequestEvent
  | CommentEvent
  | PushEvent
  | CheckRunEvent
  | IgnoredEvent;

/** Any normalized event that carries PR facts and can update the PullRequest row. */
export type PullRequestBackedEvent = Exclude<ParsedEvent, IgnoredEvent>;
