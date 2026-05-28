/**
 * Normalized webhook events. The raw GitHub payloads are large and loosely
 * typed; {@link parseEvent} narrows each supported delivery into one of these
 * shapes so the trigger-evaluator can stay a small, pure function over a
 * stable contract.
 */

/** The GitHub webhook event names Sandy subscribes to (the `X-GitHub-Event` header). */
export type SupportedEventName =
  | 'pull_request'
  | 'issue_comment'
  | 'pull_request_review_comment'
  | 'push';

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
   * Repo the PR's head branch lives in. Differs from the base Repo for a fork
   * PR, which v1 declines (PRD open question).
   */
  headRepo: RepoRef;
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

/** A webhook delivery Sandy understands but that carries no review signal. */
export interface IgnoredEvent {
  kind: 'ignored';
  reason: string;
}

/** Any normalized webhook event. */
export type ParsedEvent = PullRequestEvent | CommentEvent | PushEvent | IgnoredEvent;
