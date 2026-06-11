import type { CompleteReviewStatusCheckInput } from './review-status-check.js';

/**
 * One `running` ReviewJob found at worker startup, with the data needed to
 * terminate its dangling Sandy Check Run.
 */
export interface OrphanedRunningReview {
  jobId: string;
  checkRunId: number | null;
  headSha: string;
  owner: string;
  name: string;
  pullRequestUrl: string;
}

export interface ReconcileOrphanedReviewsDeps {
  /** All `running` ReviewJobs (orphans on a single-worker host after a restart). */
  listRunning: () => Promise<OrphanedRunningReview[]>;
  /** Terminate a Sandy Check Run (the only path with GitHub App auth + networking). */
  completeCheckRun: (input: CompleteReviewStatusCheckInput) => Promise<void>;
  /** Mark a `running` ReviewJob `failed`; returns whether it transitioned. */
  markFailed: (jobId: string, finishedAt: number, error: string) => Promise<boolean>;
  now: () => number;
  logger: { info: (message: string) => void; warn: (message: string, ...args: unknown[]) => void };
}

const ORPHAN_ERROR = 'worker exited before the review finished (orphaned on restart)';
const ORPHAN_VERDICT = 'Sandy review was interrupted (worker restart) — re-run when ready.';

/**
 * Reconcile ReviewJobs left `running` by a prior worker exit.
 *
 * Check Runs are updated inline by the review processor, so a crash or restart
 * mid-review leaves the Sandy Check Run stuck `in_progress` forever: the Convex
 * `reapStuckJobs` cron can fail the job row but cannot call GitHub. On a
 * single-worker host every `running` job at boot is such an orphan. For each, we
 * terminate the Check Run FIRST (so the PR stops showing in_progress even if the
 * status write below fails — the cron will still fail the row), then mark the job
 * `failed`. Failures are logged and skipped, never fatal to startup.
 */
export async function reconcileOrphanedReviews(
  deps: ReconcileOrphanedReviewsDeps,
): Promise<{ reconciled: number }> {
  // Best-effort startup cleanup: a failure here (Convex unreachable, function not
  // yet deployed) must NEVER stop the worker from starting. Swallow and log.
  let running: OrphanedRunningReview[];
  try {
    running = await deps.listRunning();
  } catch (error) {
    deps.logger.warn('failed to list orphaned running ReviewJobs; skipping reconciliation', error);
    return { reconciled: 0 };
  }
  if (running.length === 0) {
    return { reconciled: 0 };
  }

  deps.logger.info(
    `reconciling ${running.length} orphaned running ReviewJob(s) left by a prior worker exit`,
  );

  let reconciled = 0;
  for (const review of running) {
    if (review.checkRunId !== null) {
      try {
        await deps.completeCheckRun({
          owner: review.owner,
          repo: review.name,
          checkRunId: review.checkRunId,
          conclusion: 'cancelled',
          detailsUrl: review.pullRequestUrl,
          verdict: ORPHAN_VERDICT,
          completedAt: deps.now(),
        });
      } catch (error) {
        deps.logger.warn(
          `failed to terminate orphaned Sandy Check Run ${review.checkRunId} for ReviewJob ${review.jobId}`,
          error,
        );
      }
    }

    try {
      const transitioned = await deps.markFailed(review.jobId, deps.now(), ORPHAN_ERROR);
      if (transitioned) {
        reconciled += 1;
      }
    } catch (error) {
      deps.logger.warn(`failed to mark orphaned ReviewJob ${review.jobId} failed`, error);
    }
  }

  return { reconciled };
}
