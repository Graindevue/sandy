import { describe, expect, it, vi } from 'vitest';
import {
  type OrphanedRunningReview,
  reconcileOrphanedReviews,
} from './orphaned-review-reconciler.js';

function review(overrides: Partial<OrphanedRunningReview> = {}): OrphanedRunningReview {
  return {
    jobId: 'job:1',
    checkRunId: 555,
    headSha: 'abc1234',
    owner: 'Graindevue',
    name: 'graindevue',
    pullRequestUrl: 'https://github.com/Graindevue/graindevue/pull/236',
    ...overrides,
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn() };

function deps(
  running: OrphanedRunningReview[],
  overrides: Partial<Parameters<typeof reconcileOrphanedReviews>[0]> = {},
) {
  return {
    listRunning: vi.fn(async () => running),
    completeCheckRun: vi.fn(async () => {}),
    markFailed: vi.fn(async () => true),
    now: () => 1000,
    logger: silentLogger,
    ...overrides,
  };
}

describe('reconcileOrphanedReviews', () => {
  it('never throws when listing running jobs fails (startup must not crash)', async () => {
    const d = deps([], {
      listRunning: vi.fn(async () => {
        throw new Error('Convex unreachable / function not deployed');
      }),
    });
    const result = await reconcileOrphanedReviews(d);
    expect(result).toEqual({ reconciled: 0 });
    expect(d.completeCheckRun).not.toHaveBeenCalled();
    expect(d.markFailed).not.toHaveBeenCalled();
  });

  it('does nothing when there are no running jobs', async () => {
    const d = deps([]);
    const result = await reconcileOrphanedReviews(d);
    expect(result).toEqual({ reconciled: 0 });
    expect(d.completeCheckRun).not.toHaveBeenCalled();
    expect(d.markFailed).not.toHaveBeenCalled();
  });

  it('terminates the Check Run as cancelled and fails the job', async () => {
    const d = deps([review({ jobId: 'job:abc', checkRunId: 777 })]);
    const result = await reconcileOrphanedReviews(d);
    expect(result).toEqual({ reconciled: 1 });
    expect(d.completeCheckRun).toHaveBeenCalledWith({
      owner: 'Graindevue',
      repo: 'graindevue',
      checkRunId: 777,
      conclusion: 'cancelled',
      detailsUrl: 'https://github.com/Graindevue/graindevue/pull/236',
      verdict: expect.stringContaining('interrupted'),
      completedAt: 1000,
    });
    expect(d.markFailed).toHaveBeenCalledWith('job:abc', 1000, expect.stringContaining('orphaned'));
  });

  it('skips the Check Run call when the job never recorded one', async () => {
    const d = deps([review({ checkRunId: null })]);
    const result = await reconcileOrphanedReviews(d);
    expect(d.completeCheckRun).not.toHaveBeenCalled();
    expect(d.markFailed).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reconciled: 1 });
  });

  it('still fails the job (and does not throw) when terminating the Check Run errors', async () => {
    const d = deps([review()], {
      completeCheckRun: vi.fn(async () => {
        throw new Error('GitHub 500');
      }),
    });
    const result = await reconcileOrphanedReviews(d);
    expect(d.markFailed).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reconciled: 1 });
  });

  it('does not count a job that no longer transitions (already terminal)', async () => {
    const d = deps([review()], { markFailed: vi.fn(async () => false) });
    const result = await reconcileOrphanedReviews(d);
    expect(result).toEqual({ reconciled: 0 });
  });

  it('terminates the Check Run before marking the job failed', async () => {
    const order: string[] = [];
    const d = deps([review()], {
      completeCheckRun: vi.fn(async () => {
        order.push('check-run');
      }),
      markFailed: vi.fn(async () => {
        order.push('mark-failed');
        return true;
      }),
    });
    await reconcileOrphanedReviews(d);
    expect(order).toEqual(['check-run', 'mark-failed']);
  });
});
