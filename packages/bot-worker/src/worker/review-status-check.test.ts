import { describe, expect, it, vi } from 'vitest';
import {
  completedReviewStatusCheckOutcome,
  type ReviewStatusCheckReporter,
  startReviewStatusCheck,
} from './review-status-check.js';

const context = {
  job: {
    id: 'job-1',
    headSha: 'abc123',
  },
  repo: {
    owner: 'acme',
    name: 'widget',
  },
  pullRequest: {
    url: 'https://github.com/acme/widget/pull/12',
  },
};

describe('ReviewStatusCheckRun', () => {
  it('reuses an existing Check Run id instead of creating another one', async () => {
    const reporter = new FakeStatusCheckReporter();
    const store = { setReviewCheckRunId: vi.fn() };
    const statusCheck = await startReviewStatusCheck({
      context: {
        ...context,
        job: { ...context.job, checkRunId: 1200 },
      },
      reporter,
      store,
      now: nextNow([100]),
      logger: { warn: vi.fn() },
    });

    await statusCheck.complete({
      outcome: {
        conclusion: 'neutral',
        verdict: 'Sandy posted 2 findings',
      },
    });

    expect(reporter.created).toEqual([]);
    expect(store.setReviewCheckRunId).not.toHaveBeenCalled();
    expect(reporter.completed).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        checkRunId: 1200,
        conclusion: 'neutral',
        detailsUrl: 'https://github.com/acme/widget/pull/12',
        verdict: 'Sandy posted 2 findings',
        completedAt: 100,
      },
    ]);
  });

  it('does nothing when no reporter is configured', async () => {
    const store = { setReviewCheckRunId: vi.fn() };
    const logger = { warn: vi.fn() };
    const statusCheck = await startReviewStatusCheck({
      context,
      reporter: null,
      store,
      now: nextNow([100]),
      logger,
    });

    await statusCheck.complete({
      outcome: {
        conclusion: 'success',
        verdict: 'Sandy ran cleanly',
      },
    });

    expect(store.setReviewCheckRunId).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('maps completed Review outcomes to advisory check conclusions', () => {
    expect(
      completedReviewStatusCheckOutcome({
        selectedAgentCount: 0,
        failedAgentCount: 0,
        postedFindingCount: 0,
      }),
    ).toEqual({
      conclusion: 'neutral',
      verdict: 'Sandy completed without running agents',
    });
    expect(
      completedReviewStatusCheckOutcome({
        selectedAgentCount: 1,
        failedAgentCount: 0,
        postedFindingCount: 2,
      }),
    ).toEqual({
      conclusion: 'neutral',
      verdict: 'Sandy posted 2 findings',
    });
  });
});

function nextNow(values: number[]): () => number {
  const copy = [...values];
  return () => copy.shift() ?? values.at(-1) ?? 0;
}

class FakeStatusCheckReporter implements ReviewStatusCheckReporter {
  created: Array<Parameters<ReviewStatusCheckReporter['createInProgress']>[0]> = [];
  completed: Array<Parameters<ReviewStatusCheckReporter['complete']>[0]> = [];

  async createInProgress(
    input: Parameters<ReviewStatusCheckReporter['createInProgress']>[0],
  ): Promise<{ id: number }> {
    this.created.push(input);
    return { id: 1200 };
  }

  async complete(input: Parameters<ReviewStatusCheckReporter['complete']>[0]): Promise<void> {
    this.completed.push(input);
  }
}
