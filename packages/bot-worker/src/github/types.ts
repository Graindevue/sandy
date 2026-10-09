import type { PullRequestState } from '@sandy/shared-types';

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
   * re-reviewed by a late `@bot review` mention.
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
