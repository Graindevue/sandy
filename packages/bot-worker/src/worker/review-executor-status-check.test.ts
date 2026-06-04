import { describe, expect, it, vi } from 'vitest';
import type { ReviewAgentRunner } from './review-executor.js';
import { ReviewExecutor } from './review-executor.js';
import {
  FakeArchetypeAssigner,
  FakeCloneManager,
  FakeExecutionStore,
  FakePoster,
  FakeRunner,
  finding,
  findingsOutput,
  logicAgent,
  makeContext,
  nextNow,
  securityAgent,
} from './review-executor.test-support.js';
import type { ReviewStatusCheckReporter } from './review-status-check.js';

describe('ReviewExecutor Review Status Check', () => {
  it('creates and persists an in-progress check, then resolves a clean Review to success', async () => {
    const { executor, statusChecks, store } = makeExecutor({
      runner: new FakeRunner(findingsOutput([])),
      now: nextNow([100, 200, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(statusChecks.created).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        headSha: 'abc123',
        pullRequestUrl: 'https://github.com/acme/widget/pull/12',
        startedAt: 100,
      },
    ]);
    expect(store.checkRunIds).toEqual([{ jobId: 'job-1', checkRunId: 1200 }]);
    expect(statusChecks.completed).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        checkRunId: 1200,
        conclusion: 'success',
        detailsUrl: 'https://github.com/acme/widget/pull/12#issuecomment-900',
        summaryCommentUrl: 'https://github.com/acme/widget/pull/12#issuecomment-900',
        verdict: 'Sandy ran cleanly',
        completedAt: 400,
      },
    ]);
  });

  it('resolves a Review with posted Findings to a neutral check', async () => {
    const { executor, statusChecks } = makeExecutor({
      runner: new FakeRunner(findingsOutput([finding])),
      now: nextNow([100, 200, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(statusChecks.completed[0]).toMatchObject({
      conclusion: 'neutral',
      verdict: 'Sandy posted 1 finding',
    });
  });

  it('resolves partial Agent failure to neutral, never success', async () => {
    const { executor, statusChecks } = makeExecutor({
      store: new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] })),
      runner: {
        runAgent: async ({ agent }) => {
          if (agent.key === 'logic') {
            throw new Error('container exited with status 1');
          }
          return findingsOutput([]);
        },
      },
      resolveAgents: () => [logicAgent, securityAgent],
      now: nextNow([100, 110, 200, 210, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(statusChecks.completed[0]).toMatchObject({
      conclusion: 'neutral',
      verdict: 'Sandy completed with partial agent failures',
    });
  });

  it('resolves all-Agent failure to a failure check', async () => {
    const { executor, statusChecks, store } = makeExecutor({
      store: new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] })),
      runner: {
        runAgent: async () => {
          throw new Error('container exited with status 1');
        },
      },
      resolveAgents: () => [logicAgent, securityAgent],
      now: nextNow([100, 110, 200, 210, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 400 }]);
    expect(store.failed).toEqual([]);
    expect(statusChecks.completed[0]).toMatchObject({
      conclusion: 'failure',
      detailsUrl: 'https://github.com/acme/widget/pull/12',
      verdict: 'Sandy failed to produce review results',
    });
  });

  it('resolves hard ReviewJob failure to a failure check', async () => {
    const store = new FakeExecutionStore(makeContext());
    store.recordSynthesizedReview = async () => {
      throw new Error('Convex write failed');
    };
    const { executor, statusChecks } = makeExecutor({
      store,
      runner: new FakeRunner(findingsOutput([finding])),
      now: nextNow([100, 200, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(store.failed).toEqual([
      { jobId: 'job-1', finishedAt: 400, error: 'Convex write failed' },
    ]);
    expect(statusChecks.completed[0]).toMatchObject({
      conclusion: 'failure',
      detailsUrl: 'https://github.com/acme/widget/pull/12',
      verdict: 'Sandy failed to run',
    });
  });

  it('logs and swallows Check Run create failures without blocking review comments', async () => {
    const statusChecks = new FakeStatusCheckReporter({ failCreate: true });
    const logger = { warn: vi.fn() };
    const { executor, poster, store } = makeExecutor({
      statusChecks,
      logger,
      runner: new FakeRunner(findingsOutput([finding])),
      now: nextNow([100, 200, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(poster.results).toHaveLength(1);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 400 }]);
    expect(store.failed).toEqual([]);
    expect(store.checkRunIds).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'failed to create Sandy Check Run for ReviewJob job-1',
      expect.any(Error),
    );
  });

  it('logs and swallows Check Run update failures without blocking review comments', async () => {
    const statusChecks = new FakeStatusCheckReporter({ failComplete: true });
    const logger = { warn: vi.fn() };
    const { executor, poster, store } = makeExecutor({
      statusChecks,
      logger,
      runner: new FakeRunner(findingsOutput([finding])),
      now: nextNow([100, 200, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(poster.results).toHaveLength(1);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 400 }]);
    expect(store.failed).toEqual([]);
    expect(store.checkRunIds).toEqual([{ jobId: 'job-1', checkRunId: 1200 }]);
    expect(logger.warn).toHaveBeenCalledWith(
      'failed to update Sandy Check Run 1200 for ReviewJob job-1',
      expect.any(Error),
    );
  });
});

function makeExecutor(options: {
  store?: FakeExecutionStore;
  statusChecks?: FakeStatusCheckReporter;
  poster?: FakePoster;
  logger?: { warn(message: string, ...args: unknown[]): void };
  runner: ReviewAgentRunner;
  resolveAgents?: () => readonly [typeof logicAgent, typeof securityAgent];
  now: () => number;
}): {
  executor: ReviewExecutor;
  store: FakeExecutionStore;
  poster: FakePoster;
  statusChecks: FakeStatusCheckReporter;
} {
  const store = options.store ?? new FakeExecutionStore(makeContext());
  const poster = options.poster ?? new FakePoster();
  const statusChecks = options.statusChecks ?? new FakeStatusCheckReporter();
  const executorOptions: ConstructorParameters<typeof ReviewExecutor>[0] = {
    store,
    cloneManager: new FakeCloneManager(),
    poster,
    statusChecks,
    archetypeAssigner: new FakeArchetypeAssigner(),
    diffInspector: { changedLineCount: async () => 42 },
    runner: options.runner,
    resolveAgent: (_repo, agentKey) => (agentKey === 'logic' ? logicAgent : securityAgent),
    now: options.now,
  };
  if (options.logger !== undefined) {
    executorOptions.logger = options.logger;
  }
  if (options.resolveAgents !== undefined) {
    executorOptions.resolveAgents = options.resolveAgents;
  }

  return {
    executor: new ReviewExecutor(executorOptions),
    store,
    poster,
    statusChecks,
  };
}

class FakeStatusCheckReporter implements ReviewStatusCheckReporter {
  created: Array<Parameters<ReviewStatusCheckReporter['createInProgress']>[0]> = [];
  completed: Array<Parameters<ReviewStatusCheckReporter['complete']>[0]> = [];
  readonly #failCreate: boolean;
  readonly #failComplete: boolean;

  constructor(options: { failCreate?: boolean; failComplete?: boolean } = {}) {
    this.#failCreate = options.failCreate ?? false;
    this.#failComplete = options.failComplete ?? false;
  }

  async createInProgress(
    input: Parameters<ReviewStatusCheckReporter['createInProgress']>[0],
  ): Promise<{ id: number }> {
    this.created.push(input);
    if (this.#failCreate) {
      throw new Error('Checks API create failed');
    }
    return { id: 1200 };
  }

  async complete(input: Parameters<ReviewStatusCheckReporter['complete']>[0]): Promise<void> {
    this.completed.push(input);
    if (this.#failComplete) {
      throw new Error('Checks API update failed');
    }
  }
}
