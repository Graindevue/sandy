import type { AgentDefinition } from '@sandy/shared-types';
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
  fixtureExecutorOptions,
  logicAgent,
  makeContext,
  nextNow,
  runnerOutput,
  securityAgent,
} from './review-executor.test-support.js';
import type { ReviewStatusCheckReporter } from './review-status-check.js';

describe('ReviewExecutor Review Status Check', () => {
  it('creates and persists an in-progress check, then resolves a clean Review to success', async () => {
    const runner = new FakeRunner(findingsOutput([]));
    const { executor, statusChecks, store } = makeExecutor({
      runner: {
        runAgent: (input) => runner.runAgent(input),
        installDependencies: async () => ({
          status: 'installed',
          packageManager: 'pnpm',
          command: 'pnpm install --frozen-lockfile',
          durationMs: 100,
          testStatus: 'passed',
          testResult: 'pnpm test exited 0.',
        }),
      },
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
        verdict: 'Sandy ran cleanly. Tests passed: the project test suite ran once',
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
      verdict: 'Sandy posted 1 finding. Tests unavailable: no test-suite result was recorded',
    });
  });

  it('keeps a clean focused Review neutral and states that the full suite is deferred to CI', async () => {
    const { executor, statusChecks, poster } = makeExecutor({
      runner: {
        runAgent: async () => runnerOutput(findingsOutput([])),
        installDependencies: async () => ({
          status: 'installed',
          packageManager: 'pnpm',
          command: 'pnpm install --frozen-lockfile',
          durationMs: 100,
          testStatus: 'deferred',
          testResult: 'The full project suite is deferred to CI.',
        }),
      },
      now: nextNow([100, 200, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(statusChecks.completed[0]).toMatchObject({
      conclusion: 'neutral',
      verdict:
        'Sandy completed review. Full project test suite deferred to CI; reviewers may run focused verification',
      completedAt: 400,
    });
    expect(poster.results[0]?.summary).toMatch(
      /^Full project test suite deferred to CI; reviewers may run focused verification\.\n\nConfidence score: 5\/5/,
    );
    expect(poster.results[0]?.summary).not.toContain('Tests passed');
  });

  it('resolves partial Agent failure to neutral, never success', async () => {
    const { executor, statusChecks } = makeExecutor({
      store: new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] })),
      runner: {
        runAgent: async ({ agent }) => {
          if (agent.key === 'logic') {
            throw new Error('container exited with status 1');
          }
          return runnerOutput(findingsOutput([]));
        },
      },
      resolveAgents: () => [logicAgent, securityAgent],
      now: nextNow([100, 110, 200, 210, 300, 400]),
    });

    await executor.executeClaimedJob('job-1');

    expect(statusChecks.completed[0]).toMatchObject({
      conclusion: 'neutral',
      verdict:
        'Sandy completed with partial agent failures. Tests unavailable: no test-suite result was recorded',
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
      verdict:
        'Sandy failed to produce review results. Tests unavailable: no test-suite result was recorded',
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

  it('resolves a scope-declined oversized diff to a skipped check while posting the summary', async () => {
    const { executor, poster, statusChecks, store } = makeExecutor({
      changedLineCount: 5001,
      maxChangedLines: 5000,
      runner: {
        runAgent: async () => {
          throw new Error('should not run');
        },
      },
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(poster.scopeDeclines).toEqual([{ changedLines: 5001, maxChangedLines: 5000 }]);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 200 }]);
    expect(store.failed).toEqual([]);
    expect(statusChecks.completed).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        checkRunId: 1200,
        conclusion: 'skipped',
        detailsUrl: 'https://github.com/acme/widget/pull/12#issuecomment-900',
        summaryCommentUrl: 'https://github.com/acme/widget/pull/12#issuecomment-900',
        verdict: 'Sandy skipped this review',
        completedAt: 300,
      },
    ]);
  });

  it('resolves a superseded in-flight Review to a cancelled check without posting stale results', async () => {
    const store = new FakeExecutionStore(makeContext());
    const { executor, poster, statusChecks } = makeExecutor({
      store,
      runner: {
        runAgent: async () => {
          store.status = 'superseded';
          return runnerOutput(findingsOutput([finding], 'One issue.'));
        },
      },
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(poster.results).toEqual([]);
    expect(poster.scopeDeclines).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(statusChecks.completed).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        checkRunId: 1200,
        conclusion: 'cancelled',
        detailsUrl: 'https://github.com/acme/widget/pull/12',
        verdict: 'Sandy review was superseded by a newer push',
        completedAt: 300,
      },
    ]);
  });

  it('resolves a ReviewJob superseded during completion to a cancelled check', async () => {
    const store = new FakeExecutionStore(makeContext());
    store.markCompleted = async () => {
      store.status = 'superseded';
      return false;
    };
    const { executor, poster, statusChecks } = makeExecutor({
      store,
      runner: {
        runAgent: async () => {
          throw new Error('should not run');
        },
      },
      resolveAgents: () => [],
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(poster.results).toEqual([]);
    expect(poster.scopeDeclines).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(statusChecks.completed).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        checkRunId: 1200,
        conclusion: 'cancelled',
        detailsUrl: 'https://github.com/acme/widget/pull/12',
        verdict: 'Sandy review was superseded by a newer push',
        completedAt: 300,
      },
    ]);
  });

  it('resolves a ReviewJob superseded during failure recording to a cancelled check', async () => {
    const store = new FakeExecutionStore(makeContext());
    store.recordSynthesizedReview = async () => {
      throw new Error('Convex write failed');
    };
    store.markFailed = async () => {
      store.status = 'superseded';
      return false;
    };
    const { executor, poster, statusChecks } = makeExecutor({
      store,
      runner: new FakeRunner(findingsOutput([finding])),
      now: nextNow([100, 200, 300, 400, 500]),
    });

    await executor.executeClaimedJob('job-1');

    expect(poster.results).toEqual([]);
    expect(poster.scopeDeclines).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(statusChecks.completed).toEqual([
      {
        owner: 'acme',
        repo: 'widget',
        checkRunId: 1200,
        conclusion: 'cancelled',
        detailsUrl: 'https://github.com/acme/widget/pull/12',
        verdict: 'Sandy review was superseded by a newer push',
        completedAt: 500,
      },
    ]);
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
  changedLineCount?: number;
  maxChangedLines?: number;
  resolveAgents?: () => readonly AgentDefinition[];
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
    ...fixtureExecutorOptions,
    store,
    cloneManager: new FakeCloneManager(),
    poster,
    statusChecks,
    archetypeAssigner: new FakeArchetypeAssigner(),
    diffInspector: { changedLineCount: async () => options.changedLineCount ?? 42 },
    runner: options.runner,
    resolveAgent: (_repo, agentKey) => (agentKey === 'logic' ? logicAgent : securityAgent),
    now: options.now,
    ...(options.maxChangedLines === undefined ? {} : { maxChangedLines: options.maxChangedLines }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.resolveAgents === undefined ? {} : { resolveAgents: options.resolveAgents }),
  };

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
