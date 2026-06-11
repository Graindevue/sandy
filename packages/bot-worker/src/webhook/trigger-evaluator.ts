import type { ReviewTrigger } from '@sandy/shared-types';
import type { ParsedEvent, PullRequestBackedEvent, PullRequestFacts, RepoRef } from './events.js';

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
 * The trigger-evaluator's verdict for a single webhook event. At most one of
 * `enqueue` / `clearReviewActive` / `decline` drives dispatcher work; the others
 * stay falsy. `setReviewActive` only ever pairs with `enqueue`.
 */
export interface TriggerDecision {
  /** Enqueue a ReviewJob for this PR's current head. */
  enqueue: boolean;
  /** Mark the PR as opted into reviews (records opt-in state; see note below). */
  setReviewActive?: boolean;
  /** Clear the opt-in flag (PR closed). */
  clearReviewActive?: boolean;
  /** Why the Review was triggered; present iff `enqueue` is true. */
  trigger?: ReviewTrigger;
  /** The PR is declined without enqueuing; `'fork'` is the only v1 reason. */
  decline?: 'fork';
}

const DO_NOTHING: TriggerDecision = { enqueue: false };

interface EnqueueReviewOptions {
  setReviewActive?: true;
}

function enqueueSameRepoPr(
  event: PullRequestBackedEvent,
  trigger: ReviewTrigger,
  options: EnqueueReviewOptions = {},
): TriggerDecision {
  if (isForkPr(event.repo, event.pr)) {
    return { enqueue: false, decline: 'fork' };
  }
  return options.setReviewActive === true
    ? { enqueue: true, setReviewActive: true, trigger }
    : { enqueue: true, trigger };
}

function enqueueLiveSameRepoPr(
  event: PullRequestBackedEvent,
  trigger: ReviewTrigger,
  options: EnqueueReviewOptions = {},
): TriggerDecision {
  if (isTerminal(event.pr)) {
    return DO_NOTHING;
  }
  return enqueueSameRepoPr(event, trigger, options);
}

/**
 * Trigger evaluation, as a pure function. Decides whether a normalized webhook
 * event should enqueue a Review. No I/O — the dispatcher applies the side effects.
 *
 * Sandy reviews are **manual-only**: a Review starts when a human explicitly asks
 * for one, never automatically off a push. Rules (CONTEXT.md "Review triggers"):
 * - `@bot review` comment on an open PR → enqueue + set `reviewActive = true`
 *   (trigger `mention`); on a closed or merged PR → do nothing.
 * - Check Run re-run (the "Re-run" button on Sandy's Review Status Check) →
 *   enqueue + set `reviewActive = true` (trigger `rerun`).
 * - PR closed → clear `reviewActive`.
 * - Every other event — push, `synchronize`, `ready_for_review`, open/reopen →
 *   do nothing. Pushing new commits to a PR does NOT re-review it; the author
 *   re-runs `@bot review` (or clicks Re-run) when ready for another pass.
 * - fork PR (head Repo ≠ base Repo) → decline (`decline: 'fork'`); v1 declines
 *   forks (PRD open question) and never enqueues them.
 *
 * `reviewActive` is no longer a trigger gate (nothing pushes a re-review off it).
 * It is retained only as opt-in state — a record that a PR has been put under
 * Sandy review — for observability and possible future UI; the dispatcher keeps
 * it in sync but never reads it to decide whether to enqueue.
 *
 * Cancel-on-Supersede is applied by the dispatcher/Convex enqueue path after
 * this pure decision; the evaluator only emits the trigger.
 */
export function evaluateTrigger(event: ParsedEvent): TriggerDecision {
  switch (event.kind) {
    case 'ignored':
      return DO_NOTHING;

    case 'comment': {
      if (!isReviewMention(event.body)) {
        return DO_NOTHING;
      }
      return enqueueLiveSameRepoPr(event, 'mention', { setReviewActive: true });
    }

    case 'push':
      // Manual-only: pushes never auto-trigger a Review.
      return DO_NOTHING;

    case 'check_run': {
      return enqueueLiveSameRepoPr(event, 'rerun', { setReviewActive: true });
    }

    case 'pull_request': {
      // Close always clears the flag, fork or not — there is nothing left to
      // review and the PR should leave the opted-in set. Every other PR action
      // (synchronize, ready_for_review, open/reopen) is a no-op under manual-only
      // triggering.
      if (event.action === 'closed') {
        return { enqueue: false, clearReviewActive: true };
      }
      return DO_NOTHING;
    }
  }
}
