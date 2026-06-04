import type { RepoId } from './repo.js';

/** Stable identifier for a PullRequest (a Convex document id at runtime). */
export type PullRequestId = string;

/** The PR lifecycle states Sandy tracks. */
export type PullRequestState = 'open' | 'closed' | 'merged';

/** A pull request Sandy is aware of, plus Sandy's own review state for it. */
export interface PullRequest {
  id: PullRequestId;
  repoId: RepoId;
  /** GitHub PR number within its Repo. */
  number: number;
  state: PullRequestState;
  /** Whether the PR is currently a draft. */
  draft: boolean;
  /** Current head commit SHA. */
  headSha: string;
  /** Base branch the PR targets, e.g. `"main"`. */
  baseRef: string;
  title: string;
  /** GitHub login of the PR author. */
  author: string;
  /** Web URL of the PR. */
  url: string;
  /**
   * Sticky Opt-In flag. Flipped `true` by the first `@bot review` mention or
   * `gh pr ready` transition, or by re-running Sandy's Review Status Check;
   * cleared on close. While `true`, every push retriggers a Review automatically.
   */
  reviewActive: boolean;
}
