import type { AgentDefinition, Finding } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import { ReviewCancellationCoordinator } from './cancellation.js';
import { ReviewExecutor, type ReviewJobContext } from './review-executor.js';

const logicAgent: AgentDefinition = {
  key: 'logic',
  name: 'logic',
  description: 'Reviews logic bugs.',
  category: 'logic',
  vendor: 'claude',
  model: 'opus',
  tools: [],
  maxIterations: 1,
  completionSignal: '</findings>',
  defaultEnabled: true,
  systemPrompt: 'Review logic.',
};

const finding: Finding = {
  severity: 'P1',
  confidence: 4,
  location: {
    repo: 'acme/widget',
    path: 'src/cache.ts',
    lineStart: 12,
    lineEnd: 12,
  },
  summary: 'The cache key ignores the tenant id.',
  evidence: 'The lookup only uses userId.',
  suggestedFix: 'Include tenantId.',
  category: 'logic',
};

describe('ReviewExecutor', () => {
  it('runs the Agent, persists findings, posts comments, and completes the job', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const diffInspector = new FakeDiffInspector(42);
    const runner = new FakeRunner(
      `<findings>{"summary":"One issue.","findings":[${JSON.stringify(finding)}]}</findings>`,
    );
    const botConfig = {
      repoRules: '- Keep cache keys tenant-scoped.',
      productRules: '- API errors expose stable codes.',
      ignorePatterns: ['generated/**'],
    };
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      diffInspector,
      runner,
      resolveAgent: () => logicAgent,
      resolveReviewBotConfig: async () => botConfig,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(cloneManager.ensured).toEqual([
      { owner: 'acme', name: 'widget', defaultBranch: 'main' },
    ]);
    expect(cloneManager.created).toEqual([
      {
        repo: { owner: 'acme', name: 'widget', defaultBranch: 'main' },
        request: { reviewJobId: 'job-1', sha: 'abc123' },
      },
    ]);
    expect(store.recordedFindings).toEqual([
      expect.objectContaining({ reviewJobId: 'job-1', pullRequestId: 'pr-1', agentKey: 'logic' }),
    ]);
    expect(diffInspector.calls[0]?.ignorePatterns).toEqual(['generated/**']);
    expect(runner.calls[0]?.botConfig).toEqual(botConfig);
    expect(poster.results[0]?.findings).toEqual([{ id: 'finding-1', finding }]);
    expect(store.postedFindings).toEqual([{ findingId: 'finding-1', githubCommentId: 900 }]);
    expect(store.agentRuns).toEqual([
      {
        reviewJobId: 'job-1',
        agentKey: 'logic',
        status: 'completed',
        startedAt: 100,
        finishedAt: 200,
        findingCount: 1,
      },
    ]);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 300 }]);
    expect(store.failed).toEqual([]);
    expect(cloneManager.removed).toEqual(['job-1']);
  });

  it('marks the job failed cleanly when Agent output is malformed', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      diffInspector: { changedLineCount: async () => 42 },
      runner: { runLogicAgent: async () => '<findings>[]</findings>' },
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(poster.results).toEqual([]);
    expect(store.agentRuns[0]).toMatchObject({
      reviewJobId: 'job-1',
      agentKey: 'logic',
      status: 'failed',
      startedAt: 100,
      finishedAt: 200,
      findingCount: 0,
    });
    expect(store.failed[0]).toMatchObject({ jobId: 'job-1', finishedAt: 300 });
    expect(store.failed[0]?.error).toContain('FindingsPayload must be an object');
    expect(cloneManager.removed).toEqual(['job-1']);
  });

  it('declines oversized diffs without creating a worktree or running an Agent', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      diffInspector: { changedLineCount: async () => 5001 },
      runner: {
        runLogicAgent: async () => {
          throw new Error('should not run');
        },
      },
      resolveAgent: () => logicAgent,
      maxChangedLines: 5000,
      now: nextNow([100]),
    });

    await executor.executeClaimedJob('job-1');

    expect(cloneManager.created).toEqual([]);
    expect(poster.scopeDeclines).toEqual([{ changedLines: 5001, maxChangedLines: 5000 }]);
    expect(store.agentRuns).toEqual([]);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 100 }]);
    expect(store.failed).toEqual([]);
  });

  it('aborts a superseded in-flight Agent, removes the worktree, and posts nothing', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const cancellations = new ReviewCancellationCoordinator();
    const runnerStarted = deferred<void>();
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      cancellationRegistry: cancellations,
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runLogicAgent: async ({ signal }) =>
          new Promise<string>((_resolve, reject) => {
            runnerStarted.resolve();
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      },
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    const execution = executor.executeClaimedJob('job-1');
    await runnerStarted.promise;
    cancellations.cancelReviewJobs(['job-1']);
    await execution;

    expect(poster.results).toEqual([]);
    expect(poster.scopeDeclines).toEqual([]);
    expect(store.recordedFindings).toEqual([]);
    expect(store.agentRuns).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(cloneManager.removed).toEqual(['job-1']);
  });

  it('checks job status before posting so stale findings are not commented', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runLogicAgent: async () => {
          store.status = 'superseded';
          return `<findings>{"summary":"One issue.","findings":[${JSON.stringify(finding)}]}</findings>`;
        },
      },
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(store.recordedFindings).toEqual([]);
    expect(poster.results).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(cloneManager.removed).toEqual(['job-1']);
  });

  it('honors cancellation that arrives during the final stale-result check before posting', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const cancellations = new ReviewCancellationCoordinator();
    let statusChecks = 0;
    store.getReviewJobStatus = async () => {
      statusChecks += 1;
      if (statusChecks === 4) {
        cancellations.cancelReviewJobs(['job-1']);
      }
      return store.status;
    };
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      cancellationRegistry: cancellations,
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runLogicAgent: async () =>
          `<findings>{"summary":"One issue.","findings":[${JSON.stringify(finding)}]}</findings>`,
      },
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(poster.results).toEqual([]);
    expect(store.postedFindings).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(cloneManager.removed).toEqual(['job-1']);
  });

  it('does not start an Agent when superseded after creating the worktree', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const cancellations = new ReviewCancellationCoordinator();
    const originalCreateWorktree = cloneManager.createWorktree.bind(cloneManager);
    cloneManager.createWorktree = async (repo, request) => {
      const worktree = await originalCreateWorktree(repo, request);
      cancellations.cancelReviewJobs(['job-1']);
      return worktree;
    };
    let runnerCalls = 0;
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      cancellationRegistry: cancellations,
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runLogicAgent: async () => {
          runnerCalls += 1;
          return '<findings>{"findings":[]}</findings>';
        },
      },
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(runnerCalls).toBe(0);
    expect(poster.results).toEqual([]);
    expect(store.recordedFindings).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(cloneManager.removed).toEqual(['job-1']);
  });
});

function makeContext(): ReviewJobContext {
  return {
    job: {
      id: 'job-1',
      pullRequestId: 'pr-1',
      repoId: 'repo-1',
      headSha: 'abc123',
      agentKeys: ['logic'],
    },
    repo: {
      id: 'repo-1',
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    },
    pullRequest: {
      id: 'pr-1',
      number: 12,
      headSha: 'abc123',
      baseRef: 'main',
      title: 'Fix cache key',
      url: 'https://github.com/acme/widget/pull/12',
    },
  };
}

function nextNow(values: number[]): () => number {
  const copy = [...values];
  return () => copy.shift() ?? values.at(-1) ?? 0;
}

class FakeExecutionStore {
  recordedFindings: unknown[] = [];
  postedFindings: { findingId: string; githubCommentId: number }[] = [];
  agentRuns: unknown[] = [];
  completed: { jobId: string; finishedAt: number }[] = [];
  failed: { jobId: string; finishedAt: number; error: string }[] = [];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'superseded' | null = 'running';

  constructor(private readonly context: ReviewJobContext | null) {}

  async getReviewJobContext(): Promise<ReviewJobContext | null> {
    return this.context;
  }

  async getReviewJobStatus(): Promise<typeof this.status> {
    return this.status;
  }

  async recordFinding(input: unknown): Promise<string> {
    this.recordedFindings.push(input);
    return `finding-${this.recordedFindings.length}`;
  }

  async markFindingPosted(findingId: string, githubCommentId: number): Promise<void> {
    this.postedFindings.push({ findingId, githubCommentId });
  }

  async recordAgentRun(input: unknown): Promise<void> {
    this.agentRuns.push(input);
  }

  async markCompleted(jobId: string, finishedAt: number): Promise<void> {
    this.completed.push({ jobId, finishedAt });
  }

  async markFailed(jobId: string, finishedAt: number, error: string): Promise<void> {
    this.failed.push({ jobId, finishedAt, error });
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeCloneManager {
  ensured: unknown[] = [];
  created: unknown[] = [];
  removed: string[] = [];

  async ensureCloned(repo: unknown): Promise<void> {
    this.ensured.push(repo);
  }

  async createWorktree(
    repo: unknown,
    request: unknown,
  ): Promise<{ reviewJobId: string; path: string }> {
    this.created.push({ repo, request });
    return { reviewJobId: 'job-1', path: '/tmp/worktree/job-1' };
  }

  async removeWorktree(worktree: { reviewJobId: string }): Promise<void> {
    this.removed.push(worktree.reviewJobId);
  }
}

class FakePoster {
  results: unknown[] = [];
  scopeDeclines: { changedLines: number; maxChangedLines: number }[] = [];

  async postReviewResult(input: unknown): Promise<{ findingId: string; commentId: number }[]> {
    this.results.push(input);
    return [{ findingId: 'finding-1', commentId: 900 }];
  }

  async postScopeDeclined(input: { changedLines: number; maxChangedLines: number }): Promise<void> {
    this.scopeDeclines.push({
      changedLines: input.changedLines,
      maxChangedLines: input.maxChangedLines,
    });
  }
}

class FakeDiffInspector {
  calls: { target: unknown; ignorePatterns: unknown }[] = [];

  constructor(private readonly changedLines: number) {}

  async changedLineCount(target: unknown, ignorePatterns?: unknown): Promise<number> {
    this.calls.push({ target, ignorePatterns });
    return this.changedLines;
  }
}

class FakeRunner {
  calls: { botConfig?: unknown }[] = [];

  constructor(private readonly stdout: string) {}

  async runLogicAgent(input: { botConfig?: unknown }): Promise<string> {
    this.calls.push(input);
    return this.stdout;
  }
}
