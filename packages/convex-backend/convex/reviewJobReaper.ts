export const STUCK_REVIEW_JOB_TIMEOUT_MS = 30 * 60 * 1000;
export const STUCK_REVIEW_JOB_ERROR =
  'ReviewJob exceeded the 30 minute running timeout and was reaped by cron.';
export const REAP_STUCK_REVIEW_JOBS_BATCH_SIZE = 100;

export interface ReviewJobReaperCandidate {
  readonly status: string;
  readonly claimedAt?: number;
}

export function stuckReviewJobCutoff(now: number): number {
  return now - STUCK_REVIEW_JOB_TIMEOUT_MS;
}

export function shouldReapStuckReviewJob(job: ReviewJobReaperCandidate, now: number): boolean {
  return (
    job.status === 'running' &&
    typeof job.claimedAt === 'number' &&
    job.claimedAt < stuckReviewJobCutoff(now)
  );
}
