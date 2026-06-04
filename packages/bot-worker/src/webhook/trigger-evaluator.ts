import type { ReviewTrigger } from '@sandy/shared-types';
import type { ParsedEvent, PullRequestFacts, RepoRef } from './events.js';

/**
 * Matches an `@bot review` mention anywhere in a comment body. Case-insensitive,
 * tolerant of surrounding whitespace, and anchored on word boundaries so it does
 * not fire on substrings like `@bottle` or `previewed`.
 */
const MENTION_PATTERN = /(^|\s)@bot\s+review\b/i;

/** Whether a comment body opts the PR in to reviews. */
export function isReviewMention(body: string): boolean {
  return MENTION_PATTERN.test(body);
}

/**
 * Whether the PR must be treated as a fork — i.e. its head commit is not in the
 * base Repo and so cannot be fetched securely in v1. True when the head Repo
 * differs from the base Repo, and also when the head Repo is unknown (`null`,
 * e.g. GitHub sent `head.repo: null` for a deleted fork): an unresolvable head is
 * declined rather than silently attributed to the base Repo, which would let a
 * review run against an unfetchable SHA.
 */
export function isForkPr(repo: RepoRef, pr: PullRequestFacts): boolean {
  if (pr.headRepo === null) {
    return true;
  }
  return (
    repo.owner.toLowerCase() !== pr.headRepo.owner.toLowerCase() ||
    repo.name.toLowerCase() !== pr.headRepo.name.toLowerCase()
  );
}

/**
 * Whether the PR is in a terminal lifecycle state (closed or merged). A late
 * `@bot review` mention on such a PR must not enqueue a job against its dead head
 * SHA nor re-arm `reviewActive` (which `clearOnClose` already cleared).
 */
function isTerminal(pr: PullRequestFacts): boolean {
  return pr.state === 'closed' || pr.state === 'merged';
}

/**
 * The trigger-evaluator's verdict for a single webhook event. Exactly one of
 * `enqueue` / `clearReviewActive` / `decline` drives a side effect; the others
 * stay falsy. `setReviewActive` only ever pairs with `enqueue`.
 */
export interface TriggerDecision {
  /** Enqueue a ReviewJob for this PR's current head. */
  enqueue: boolean;
  /** Flip the PR's Sticky Opt-In flag on (first mention / ready transition). */
  setReviewActive?: boolean;
  /** Clear the Sticky Opt-In flag (PR closed). */
  clearReviewActive?: boolean;
  /** Why the Review was triggered; present iff `enqueue` is true. */
  trigger?: ReviewTrigger;
  /** The PR is declined without enqueuing; `'fork'` is the only v1 reason. */
  decline?: 'fork';
  /** The Review was intentionally skipped without side effects. */
  skip?: 'base-branch-excluded';
}

const DO_NOTHING: TriggerDecision = { enqueue: false };

/**
 * Sticky Opt-In, as a pure function. Decides whether a normalized webhook event
 * should enqueue a Review and how it moves the PR's `reviewActive` flag, given
 * that flag's current value. No I/O — the dispatcher applies the side effects.
 *
 * Rules (CONTEXT.md "Sticky Opt-In"):
 * - opened / synchronize on a PR with `reviewActive === false` and no mention →
 *   do nothing (PRs are not auto-reviewed on open).
 * - `@bot review` comment on an open PR → enqueue + set `reviewActive = true`
 *   (trigger `mention`); on a closed or merged PR → do nothing.
 * - draft → ready transition (`ready_for_review`) → enqueue + set
 *   `reviewActive = true` (trigger `ready`) unless the dispatcher says the PR's
 *   base branch is excluded from automatic arming.
 * - push / synchronize on a `reviewActive` PR → enqueue (trigger `push`).
 *   Pushes to an opted-out, closed, or merged PR are ignored.
 * - PR closed → clear `reviewActive`.
 * - fork PR (head Repo ≠ base Repo) → decline (`decline: 'fork'`); v1 declines
 *   forks (PRD open question) and never enqueues them.
 *
 * Cancel-on-Supersede is applied by the dispatcher/Convex enqueue path after
 * this pure decision; the evaluator only emits the trigger.
 */
export function evaluateTrigger(
  event: ParsedEvent,
  currentReviewActive: boolean,
  baseBranchExcluded = false,
): TriggerDecision {
  switch (event.kind) {
    case 'ignored':
      return DO_NOTHING;

    case 'comment': {
      if (!isReviewMention(event.body)) {
        return DO_NOTHING;
      }
      // A mention on a closed or merged PR is a no-op: there is no live head to
      // review, and re-arming `reviewActive` would defeat the clear-on-close that
      // already ran. Do nothing — neither enqueue nor flip the flag.
      if (isTerminal(event.pr)) {
        return DO_NOTHING;
      }
      // A fork PR cannot be reviewed in v1; decline before opting it in so the
      // sticky flag never flips on for a PR we will not review.
      if (isForkPr(event.repo, event.pr)) {
        return { enqueue: false, decline: 'fork' };
      }
      return { enqueue: true, setReviewActive: true, trigger: 'mention' };
    }

    case 'push': {
      // A push to a closed or merged PR must not re-review a dead head SHA, even
      // if `reviewActive` is stale (e.g. the `closed` webhook was missed). The
      // parsed PR state is authoritative; the flag alone is not.
      if (isTerminal(event.pr)) {
        return DO_NOTHING;
      }
      if (!currentReviewActive) {
        return DO_NOTHING;
      }
      if (isForkPr(event.repo, event.pr)) {
        return { enqueue: false, decline: 'fork' };
      }
      return { enqueue: true, trigger: 'push' };
    }

    case 'pull_request': {
      switch (event.action) {
        case 'closed':
          // Close always clears the flag, fork or not — there is nothing left to
          // review and the PR should leave the sticky set.
          return { enqueue: false, clearReviewActive: true };

        case 'ready_for_review': {
          if (isForkPr(event.repo, event.pr)) {
            return { enqueue: false, decline: 'fork' };
          }
          if (baseBranchExcluded) {
            return { enqueue: false, skip: 'base-branch-excluded' };
          }
          return { enqueue: true, setReviewActive: true, trigger: 'ready' };
        }

        case 'synchronize': {
          // A push to a PR can arrive as both `push` and `synchronize`.
          // The dispatcher uses an idempotent push enqueue, so both normalized
          // events can safely request the same new-head review for opted-in PRs.
          if (isTerminal(event.pr)) {
            // A synchronize on a closed/merged PR with a stale `reviewActive`
            // must not enqueue against a dead head SHA.
            return DO_NOTHING;
          }
          if (!currentReviewActive) {
            return DO_NOTHING;
          }
          if (isForkPr(event.repo, event.pr)) {
            return { enqueue: false, decline: 'fork' };
          }
          return { enqueue: true, trigger: 'push' };
        }

        case 'opened':
        case 'reopened':
        case 'other':
          // Sticky Opt-In: opening (or reopening) a PR never auto-reviews it.
          return DO_NOTHING;
      }
    }
  }
}
