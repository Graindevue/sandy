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

const securityAgent: AgentDefinition = {
  ...logicAgent,
  key: 'security',
  name: 'security',
  description: 'Reviews security issues.',
  category: 'security',
  systemPrompt: 'Review security.',
};

const finding: Finding = {
  severity: 'P1',
  confidence: 4,
  agentKey: 'logic',
  anchor: {
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

const securityFinding: Finding = {
  ...finding,
  agentKey: 'security',
  summary: 'The endpoint accepts an untrusted redirect target.',
  category: 'security',
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
      expect.objectContaining({ reviewJobId: 'job-1', pullRequestId: 'pr-1', finding }),
    ]);
    expect(diffInspector.calls[0]?.ignorePatterns).toEqual(['generated/**']);
    expect(runner.calls[0]?.botConfig).toEqual(botConfig);
    expect(poster.results[0]?.findings).toEqual([{ id: 'finding-1', finding }]);
    expect(poster.results[0]?.siblingShas).toEqual({});
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
    expect(cloneManager.removed).toEqual(['acme/widget@job-1']);
  });

  it('runs selected Agents concurrently and records each Agent result', async () => {
    const store = new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] }));
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const securityStarted = deferred<void>();
    const runnerCalls: string[] = [];
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async ({ agent }) => {
          runnerCalls.push(agent.key);
          if (agent.key === 'logic') {
            await securityStarted.promise;
            return `<findings>{"findings":[${JSON.stringify(finding)}]}</findings>`;
          }
          securityStarted.resolve();
          return `<findings>{"findings":[${JSON.stringify(securityFinding)}]}</findings>`;
        },
      },
      resolveAgent: (_repo, agentKey) => (agentKey === 'logic' ? logicAgent : securityAgent),
      resolveAgents: () => [logicAgent, securityAgent],
      now: nextNow([100, 110, 200, 210, 300]),
    });

    await expect(withTimeout(executor.executeClaimedJob('job-1'), 250)).resolves.toBeUndefined();

    expect(runnerCalls.sort()).toEqual(['logic', 'security']);
    expect(store.recordedFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewJobId: 'job-1',
          pullRequestId: 'pr-1',
          finding,
        }),
        expect.objectContaining({
          reviewJobId: 'job-1',
          pullRequestId: 'pr-1',
          finding: securityFinding,
        }),
      ]),
    );
    expect(store.agentRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentKey: 'logic', status: 'completed', findingCount: 1 }),
        expect.objectContaining({ agentKey: 'security', status: 'completed', findingCount: 1 }),
      ]),
    );
    expect(poster.results.map((result) => result.agentKey).sort()).toEqual(['logic', 'security']);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 300 }]);
    expect(store.failed).toEqual([]);
  });

  it('records a failed Agent run without blocking other Agents from posting findings', async () => {
    const store = new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] }));
    const executor = new ReviewExecutor({
      store,
      cloneManager: new FakeCloneManager(),
      poster: new FakePoster(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async ({ agent }) => {
          if (agent.key === 'logic') {
            throw new Error('container exited with status 1');
          }
          return `<findings>{"findings":[${JSON.stringify(securityFinding)}]}</findings>`;
        },
      },
      resolveAgent: (_repo, agentKey) => (agentKey === 'logic' ? logicAgent : securityAgent),
      resolveAgents: () => [logicAgent, securityAgent],
      now: nextNow([100, 110, 200, 210, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(store.agentRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentKey: 'logic',
          status: 'failed',
          findingCount: 0,
          error: 'container exited with status 1',
        }),
        expect.objectContaining({
          agentKey: 'security',
          status: 'completed',
          findingCount: 1,
        }),
      ]),
    );
    expect(store.recordedFindings).toEqual([expect.objectContaining({ finding: securityFinding })]);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 300 }]);
    expect(store.failed).toEqual([]);
  });

  it('records timed_out when one Agent exceeds its execution cap', async () => {
    const store = new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] }));
    const executor = new ReviewExecutor({
      store,
      cloneManager: new FakeCloneManager(),
      poster: new FakePoster(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async ({ agent }) => {
          if (agent.key === 'logic') {
            return await new Promise<string>(() => {});
          }
          return '<findings>{"findings":[]}</findings>';
        },
      },
      resolveAgent: (_repo, agentKey) => (agentKey === 'logic' ? logicAgent : securityAgent),
      resolveAgents: () => [logicAgent, securityAgent],
      agentTimeoutMs: 5,
      now: nextNow([100, 110, 200, 210, 300]),
    });

    await expect(withTimeout(executor.executeClaimedJob('job-1'), 250)).resolves.toBeUndefined();

    expect(store.agentRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentKey: 'logic',
          status: 'timed_out',
          findingCount: 0,
        }),
        expect.objectContaining({ agentKey: 'security', status: 'completed' }),
      ]),
    );
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 300 }]);
    expect(store.failed).toEqual([]);
  });

  it('builds, records, and injects the ApiSurfaceManifest for every Product Repo', async () => {
    const context = makeContext({
      productRepos: [
        {
          id: 'repo-1',
          owner: 'acme',
          name: 'widget',
          fullName: 'acme/widget',
          defaultBranch: 'main',
        },
        {
          id: 'repo-2',
          owner: 'acme',
          name: 'desktop',
          fullName: 'acme/desktop',
          defaultBranch: 'main',
        },
      ],
    });
    const store = new FakeExecutionStore(context);
    const cloneManager = new FakeCloneManager();
    cloneManager.defaultBranchShas.set('acme/desktop', 'def456');
    let runnerInput: unknown;
    const manifestBuilds: unknown[] = [];
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster: new FakePoster(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async (input) => {
          runnerInput = input;
          return '<findings>{"findings":[]}</findings>';
        },
      },
      manifestBuilder: {
        buildManifest: async (productId, repoShas) => {
          manifestBuilds.push({ productId, repoShas });
          return {
            markdown: '# API Surface Manifest\n\n## acme/widget\n',
            structured: {
              productId,
              builtAt: 1234,
              repoShas: repoShas.map((repo) => ({ repo: repo.fullName, sha: repo.sha })),
              repos: [],
            },
          };
        },
      },
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(cloneManager.ensured).toEqual([
      { owner: 'acme', name: 'widget', defaultBranch: 'main' },
      { owner: 'acme', name: 'desktop', defaultBranch: 'main' },
    ]);
    expect(cloneManager.defaultBranchResolutions).toEqual([
      { owner: 'acme', name: 'desktop', defaultBranch: 'main' },
    ]);
    expect(manifestBuilds).toEqual([
      {
        productId: 'product-1',
        repoShas: [
          expect.objectContaining({
            fullName: 'acme/widget',
            sha: 'abc123',
            worktreePath: '/tmp/worktree/acme/widget/job-1',
          }),
          expect.objectContaining({
            fullName: 'acme/desktop',
            sha: 'def456',
            worktreePath: '/tmp/worktree/acme/desktop/job-1',
          }),
        ],
      },
    ]);
    expect(store.recordedManifests).toEqual([
      {
        productId: 'product-1',
        repoShas: [
          { repo: 'acme/widget', sha: 'abc123' },
          { repo: 'acme/desktop', sha: 'def456' },
        ],
        markdown: '# API Surface Manifest\n\n## acme/widget\n',
        builtAt: 1234,
      },
    ]);
    expect(runnerInput).toMatchObject({
      worktreePath: '/tmp/worktree/acme/widget/job-1',
      apiSurfaceManifest: '# API Surface Manifest\n\n## acme/widget\n',
      siblingWorktrees: [
        {
          repo: 'acme/desktop',
          sha: 'def456',
          hostPath: '/tmp/worktree/acme/desktop/job-1',
          sandboxPath: '/workspace/acme/desktop',
        },
      ],
    });
    expect(cloneManager.removed).toEqual(['acme/desktop@job-1', 'acme/widget@job-1']);
  });

  it('records a failed Agent run when Agent output is malformed', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      diffInspector: { changedLineCount: async () => 42 },
      runner: { runAgent: async () => '<findings>[]</findings>' },
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
    expect(store.agentRuns[0]).toMatchObject({
      error: expect.stringContaining('FindingsPayload must be an object'),
    });
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 300 }]);
    expect(store.failed).toEqual([]);
    expect(cloneManager.removed).toEqual(['acme/widget@job-1']);
  });

  it('marks the job failed when persistence fails after a successful Agent run', async () => {
    const store = new FakeExecutionStore(makeContext());
    store.recordFinding = async () => {
      throw new Error('Convex write failed');
    };
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async () =>
          `<findings>{"summary":"One issue.","findings":[${JSON.stringify(finding)}]}</findings>`,
      },
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

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
    expect(poster.results).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(store.failed).toEqual([
      { jobId: 'job-1', finishedAt: 300, error: 'Convex write failed' },
    ]);
    expect(cloneManager.removed).toEqual(['acme/widget@job-1']);
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
        runAgent: async () => {
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
        runAgent: async ({ signal }) =>
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
    expect(cloneManager.removed).toEqual(['acme/widget@job-1']);
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
        runAgent: async () => {
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
    expect(cloneManager.removed).toEqual(['acme/widget@job-1']);
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
        runAgent: async () =>
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
    expect(cloneManager.removed).toEqual(['acme/widget@job-1']);
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
        runAgent: async () => {
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
    expect(cloneManager.removed).toEqual(['acme/widget@job-1']);
  });
});

function makeContext(
  options: { productRepos?: ReviewJobContext['product']['repos']; agentKeys?: string[] } = {},
): ReviewJobContext {
  return {
    job: {
      id: 'job-1',
      pullRequestId: 'pr-1',
      repoId: 'repo-1',
      headSha: 'abc123',
      agentKeys: options.agentKeys ?? ['logic'],
      confidenceScore: 0,
      agentRuns: [],
      siblingShas: {},
    },
    repo: {
      id: 'repo-1',
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    },
    product: {
      id: 'product-1',
      slug: 'acme',
      name: 'Acme',
      repos: options.productRepos ?? [
        {
          id: 'repo-1',
          owner: 'acme',
          name: 'widget',
          fullName: 'acme/widget',
          defaultBranch: 'main',
        },
      ],
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
  recordedManifests: unknown[] = [];
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

  async recordApiSurfaceManifest(input: unknown): Promise<void> {
    this.recordedManifests.push(input);
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
  defaultBranchResolutions: unknown[] = [];
  defaultBranchShas = new Map<string, string>();
  removed: string[] = [];

  async ensureCloned(repo: { owner: string; name: string; defaultBranch: string }): Promise<void> {
    this.ensured.push(repo);
  }

  async resolveDefaultBranchSha(repo: { owner: string; name: string }): Promise<string> {
    this.defaultBranchResolutions.push(repo);
    return this.defaultBranchShas.get(`${repo.owner}/${repo.name}`) ?? 'default-sha';
  }

  async createWorktree(
    repo: { owner: string; name: string; defaultBranch: string },
    request: { reviewJobId: string; sha: string },
  ): Promise<{
    repo: { owner: string; name: string; defaultBranch: string };
    reviewJobId: string;
    path: string;
    sha: string;
  }> {
    this.created.push({ repo, request });
    return {
      repo,
      reviewJobId: request.reviewJobId,
      sha: request.sha,
      path: `/tmp/worktree/${repo.owner}/${repo.name}/${request.reviewJobId}`,
    };
  }

  async removeWorktree(worktree: {
    repo: { owner: string; name: string };
    reviewJobId: string;
  }): Promise<void> {
    this.removed.push(`${worktree.repo.owner}/${worktree.repo.name}@${worktree.reviewJobId}`);
  }
}

class FakePoster {
  results: Array<{ agentKey: string; findings: unknown[]; siblingShas: Record<string, string> }> =
    [];
  scopeDeclines: { changedLines: number; maxChangedLines: number }[] = [];

  async postReviewResult(input: {
    agentKey: string;
    findings: unknown[];
    siblingShas: Record<string, string>;
  }): Promise<{ findingId: string; commentId: number }[]> {
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

  async runAgent(input: { botConfig?: unknown }): Promise<string> {
    this.calls.push(input);
    return this.stdout;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}
