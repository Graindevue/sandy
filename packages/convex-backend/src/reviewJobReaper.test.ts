import { describe, expect, it } from 'vitest';
import {
  STUCK_REVIEW_JOB_TIMEOUT_MS,
  shouldReapStuckReviewJob,
  stuckReviewJobCutoff,
} from '../convex/reviewJobReaper.js';

describe('ReviewJob stuck-job reaper', () => {
  const now = 1_000_000_000;
  const justOverTimeout = now - STUCK_REVIEW_JOB_TIMEOUT_MS - 1;
  const exactlyAtTimeout = now - STUCK_REVIEW_JOB_TIMEOUT_MS;

  it('reaps only running jobs claimed more than 30 minutes ago', () => {
    expect(stuckReviewJobCutoff(now)).toBe(now - STUCK_REVIEW_JOB_TIMEOUT_MS);

    expect(shouldReapStuckReviewJob({ status: 'running', claimedAt: justOverTimeout }, now)).toBe(
      true,
    );
    expect(shouldReapStuckReviewJob({ status: 'running', claimedAt: exactlyAtTimeout }, now)).toBe(
      false,
    );
    expect(shouldReapStuckReviewJob({ status: 'pending', claimedAt: now - 1_800_001 }, now)).toBe(
      false,
    );
    expect(shouldReapStuckReviewJob({ status: 'running' }, now)).toBe(false);
  });
});
