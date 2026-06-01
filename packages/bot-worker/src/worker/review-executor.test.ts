import type { AgentDefinition, Finding, ReviewJobStatus, SiblingShas } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import { ReviewCancellationCoordinator } from './cancellation.js';
import {
  type RecordAgentRunInput,
  type RecordSynthesizedReviewInput,
  type ReviewAgentRunner,
  type ReviewArchetypeAssigner,
  type ReviewDiffInspector,
  type ReviewExecutionStore,
  ReviewExecutor,
  type ReviewJobContext,
  type ReviewPoster,
} from './review-executor.js';
import type { ArchetypeAssignedFinding, PersistedFinding } from './review-findings.js';

interface RecordedFinding {
  reviewJobId: string;
  pullRequestId: string;
  finding: Finding;
}

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

const skippedCrossRepoSearch = {
  status: 'skipped' as const,
  trigger: 'none' as const,
  rationale: 'No cross-repo contract risk was detected.',
};

describe('ReviewExecutor', () => {
  it('runs the Agent, persists findings, posts comments, and completes the job', async () => {
    const store = new FakeExecutionStore(makeContext());
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const diffInspector = new FakeDiffInspector(42);
    const runner = new FakeRunner(findingsOutput([finding], 'One issue.'));
    const botConfig = {
      repoRules: '- Keep cache keys tenant-scoped.',
      productRules: '- API errors expose stable codes.',
      ignorePatterns: ['generated/**'],
    };
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      archetypeAssigner: new FakeArchetypeAssigner(),
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
    expect(poster.results[0]?.findings).toEqual([
      { id: 'finding-1', archetypeId: 'archetype-1', finding },
    ]);
    expect(poster.results[0]?.siblingShas).toEqual({});
    expect(poster.results[0]?.summary).toContain('Confidence score: 2/5');
    expect(poster.results[0]?.summary).toContain(
      'Cross-repo search:\n- logic: skipped (none) - No cross-repo contract risk was detected.',
    );
    expect(store.confidenceScores).toEqual([{ jobId: 'job-1', confidenceScore: 2 }]);
    expect(store.postedFindings).toEqual([{ findingId: 'finding-1', githubCommentId: 900 }]);
    expect(store.agentRuns).toEqual([
      {
        reviewJobId: 'job-1',
        agentKey: 'logic',
        status: 'completed',
        startedAt: 100,
        finishedAt: 200,
        findingCount: 1,
        crossRepoSearch: skippedCrossRepoSearch,
      },
    ]);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 300 }]);
    expect(store.failed).toEqual([]);
    expect(cloneManager.removed).toEqual(['acme/widget@job-1']);
  });

  it('posts findings without learning metadata when archetype assignment fails', async () => {
    const store = new FakeExecutionStore(makeContext());
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager: new FakeCloneManager(),
      poster,
      archetypeAssigner: new ThrowingArchetypeAssigner(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: new FakeRunner(findingsOutput([finding], 'One issue.')),
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(store.recordedFindings).toEqual([
      expect.objectContaining({ reviewJobId: 'job-1', pullRequestId: 'pr-1', finding }),
    ]);
    expect(poster.results[0]?.findings).toEqual([{ id: 'finding-1', finding }]);
    expect(store.postedFindings).toEqual([{ findingId: 'finding-1', githubCommentId: 900 }]);
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 300 }]);
    expect(store.failed).toEqual([]);
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
      archetypeAssigner: new FakeArchetypeAssigner(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async ({ agent }) => {
          runnerCalls.push(agent.key);
          if (agent.key === 'logic') {
            await securityStarted.promise;
            return findingsOutput([finding]);
          }
          securityStarted.resolve();
          return findingsOutput([securityFinding]);
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
    expect(poster.results).toHaveLength(1);
    expect(poster.results[0]?.findings).toEqual([
      { id: 'finding-1', archetypeId: 'archetype-1', finding },
      { id: 'finding-2', archetypeId: 'archetype-2', finding: securityFinding },
    ]);
    expect(poster.results[0]?.summary).toContain('Sandy review posted 2 findings.');
    expect(store.completed).toEqual([{ jobId: 'job-1', finishedAt: 300 }]);
    expect(store.failed).toEqual([]);
  });

  it('dedupes cross-Agent Findings before persisting and posts one synthesized summary', async () => {
    const duplicateSecurityFinding: Finding = {
      ...finding,
      severity: 'P0',
      confidence: 5,
      agentKey: 'security',
      summary: 'Cache key ignores tenant id.',
      evidence: 'The security Agent found tenant-scoped input dropped from the key.',
      category: 'security',
    };
    const store = new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] }));
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager: new FakeCloneManager(),
      poster,
      archetypeAssigner: new FakeArchetypeAssigner(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async ({ agent }) => {
          if (agent.key === 'logic') {
            return findingsOutput([finding], 'Logic saw the cache issue.');
          }
          return findingsOutput([duplicateSecurityFinding], 'Security saw the cache issue.');
        },
      },
      resolveAgent: (_repo, agentKey) => (agentKey === 'logic' ? logicAgent : securityAgent),
      resolveAgents: () => [logicAgent, securityAgent],
      now: nextNow([100, 110, 200, 210, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(store.recordedFindings).toEqual([
      expect.objectContaining({
        reviewJobId: 'job-1',
        pullRequestId: 'pr-1',
        finding: duplicateSecurityFinding,
      }),
    ]);
    expect(store.confidenceScores).toEqual([{ jobId: 'job-1', confidenceScore: 5 }]);
    expect(poster.results).toHaveLength(1);
    expect(poster.results[0]?.findings).toEqual([
      { id: 'finding-1', archetypeId: 'archetype-1', finding: duplicateSecurityFinding },
    ]);
    expect(poster.results[0]?.summary).toContain(
      'Synthesized 2 raw findings into 1 posted finding.',
    );
  });

  it('persists suppressed Archetype Findings but filters them before posting', async () => {
    const unsuppressedFinding: Finding = {
      ...finding,
      anchor: { ...finding.anchor, lineStart: 13, lineEnd: 13 },
      summary: 'The endpoint accepts an untrusted redirect target.',
      category: 'security',
    };
    const store = new FakeExecutionStore(makeContext());
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager: new FakeCloneManager(),
      poster,
      archetypeAssigner: new FakeArchetypeAssigner([0.7, 0.69]),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async () => findingsOutput([finding, unsuppressedFinding]),
      },
      resolveAgent: () => logicAgent,
      now: nextNow([100, 200, 300]),
    });

    await executor.executeClaimedJob('job-1');

    expect(store.recordedFindings).toEqual([
      expect.objectContaining({ finding }),
      expect.objectContaining({ finding: unsuppressedFinding }),
    ]);
    expect(poster.results).toHaveLength(1);
    expect(poster.results[0]?.findings).toEqual([
      { id: 'finding-2', archetypeId: 'archetype-2', finding: unsuppressedFinding },
    ]);
    expect(poster.results[0]?.summary).toContain('Sandy review posted 1 finding.');
    expect(poster.results[0]?.summary).toContain(unsuppressedFinding.summary);
    expect(poster.results[0]?.summary).not.toContain(finding.summary);
    expect(store.postedFindings).toEqual([{ findingId: 'finding-2', githubCommentId: 900 }]);
  });

  it('records a failed Agent run without blocking other Agents from posting findings', async () => {
    const store = new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] }));
    const executor = new ReviewExecutor({
      store,
      cloneManager: new FakeCloneManager(),
      poster: new FakePoster(),
      archetypeAssigner: new FakeArchetypeAssigner(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async ({ agent }) => {
          if (agent.key === 'logic') {
            throw new Error('container exited with status 1');
          }
          return findingsOutput([securityFinding]);
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
      archetypeAssigner: new FakeArchetypeAssigner(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async ({ agent }) => {
          if (agent.key === 'logic') {
            return await new Promise<string>(() => {});
          }
          return findingsOutput([]);
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
    const poster = new FakePoster();
    let runnerInput: unknown;
    const manifestBuilds: unknown[] = [];
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      archetypeAssigner: new FakeArchetypeAssigner(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async (input) => {
          runnerInput = input;
          return findingsOutput([]);
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
    expect(store.recordedSiblingShas).toEqual([
      {
        jobId: 'job-1',
        siblingShas: { 'acme/desktop': 'def456' },
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
    expect(poster.results.map((result) => result.siblingShas)).toEqual([
      { 'acme/desktop': 'def456' },
    ]);
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
      archetypeAssigner: new FakeArchetypeAssigner(),
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
    store.recordSynthesizedReview = async () => {
      throw new Error('Convex write failed');
    };
    const cloneManager = new FakeCloneManager();
    const poster = new FakePoster();
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      poster,
      archetypeAssigner: new FakeArchetypeAssigner(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async () => findingsOutput([finding], 'One issue.'),
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
        crossRepoSearch: skippedCrossRepoSearch,
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
      archetypeAssigner: new FakeArchetypeAssigner(),
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
      archetypeAssigner: new FakeArchetypeAssigner(),
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
      archetypeAssigner: new FakeArchetypeAssigner(),
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async () => {
          store.status = 'superseded';
          return findingsOutput([finding], 'One issue.');
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
      archetypeAssigner: new FakeArchetypeAssigner(),
      cancellationRegistry: cancellations,
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async () => findingsOutput([finding], 'One issue.'),
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
      archetypeAssigner: new FakeArchetypeAssigner(),
      cancellationRegistry: cancellations,
      diffInspector: { changedLineCount: async () => 42 },
      runner: {
        runAgent: async () => {
          runnerCalls += 1;
          return findingsOutput([]);
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

function findingsOutput(findings: Finding[], summary?: string): string {
  const payload: {
    findings: Finding[];
    crossRepoSearch: typeof skippedCrossRepoSearch;
    summary?: string;
  } = {
    findings,
    crossRepoSearch: skippedCrossRepoSearch,
  };
  if (summary !== undefined) {
    payload.summary = summary;
  }
  return `<findings>${JSON.stringify(payload)}</findings>`;
}

class FakeExecutionStore implements ReviewExecutionStore {
  recordedManifests: Array<{
    productId: string;
    repoShas: { repo: string; sha: string }[];
    markdown: string;
    builtAt: number;
  }> = [];
  recordedSiblingShas: { jobId: string; siblingShas: SiblingShas }[] = [];
  confidenceScores: { jobId: string; confidenceScore: Finding['confidence'] }[] = [];
  recordedFindings: RecordedFinding[] = [];
  postedFindings: { findingId: string; githubCommentId: number }[] = [];
  agentRuns: RecordAgentRunInput[] = [];
  completed: { jobId: string; finishedAt: number }[] = [];
  failed: { jobId: string; finishedAt: number; error: string }[] = [];
  status: ReviewJobStatus | null = 'running';

  constructor(private readonly context: ReviewJobContext | null) {}

  async getReviewJobContext(_jobId: string): Promise<ReviewJobContext | null> {
    return this.context;
  }

  async getReviewJobStatus(_jobId: string): Promise<typeof this.status> {
    return this.status;
  }

  async recordApiSurfaceManifest(input: {
    productId: string;
    repoShas: { repo: string; sha: string }[];
    markdown: string;
    builtAt: number;
  }): Promise<void> {
    this.recordedManifests.push(input);
  }

  async recordSiblingShas(jobId: string, siblingShas: SiblingShas): Promise<void> {
    this.recordedSiblingShas.push({ jobId, siblingShas });
  }

  async recordSynthesizedReview(input: RecordSynthesizedReviewInput): Promise<PersistedFinding[]> {
    this.confidenceScores.push({
      jobId: input.reviewJobId,
      confidenceScore: input.confidenceScore,
    });
    return input.findings.map((finding) => {
      this.recordedFindings.push({
        reviewJobId: input.reviewJobId,
        pullRequestId: input.pullRequestId,
        finding,
      });
      return { id: `finding-${this.recordedFindings.length}`, finding };
    });
  }

  async markFindingPosted(findingId: string, githubCommentId: number): Promise<void> {
    this.postedFindings.push({ findingId, githubCommentId });
  }

  async recordAgentRun(input: RecordAgentRunInput): Promise<void> {
    this.agentRuns.push(input);
  }

  async markCompleted(jobId: string, finishedAt: number): Promise<void> {
    this.completed.push({ jobId, finishedAt });
  }

  async markFailed(jobId: string, finishedAt: number, error: string): Promise<void> {
    this.failed.push({ jobId, finishedAt, error });
  }
}

class FakeArchetypeAssigner implements ReviewArchetypeAssigner {
  constructor(private readonly suppressionWeights: readonly number[] = []) {}

  async assignArchetypes(
    findings: readonly PersistedFinding[],
  ): Promise<ArchetypeAssignedFinding[]> {
    return findings.map((finding, index) => ({
      ...finding,
      archetypeId: `archetype-${index + 1}`,
      archetypeSuppressionWeight: this.suppressionWeights[index] ?? 0,
    }));
  }
}

class ThrowingArchetypeAssigner implements ReviewArchetypeAssigner {
  async assignArchetypes(): Promise<ArchetypeAssignedFinding[]> {
    throw new Error('Ollama embedding request failed: connect ECONNREFUSED 127.0.0.1:11434');
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

class FakePoster implements ReviewPoster {
  results: Array<Parameters<ReviewPoster['postReviewResult']>[0]> = [];
  scopeDeclines: { changedLines: number; maxChangedLines: number }[] = [];

  async postReviewResult(
    input: Parameters<ReviewPoster['postReviewResult']>[0],
  ): Promise<{ findingId: string; commentId: number }[]> {
    this.results.push(input);
    return input.findings.map((finding, index) => ({
      findingId: finding.id,
      commentId: 900 + index,
    }));
  }

  async postScopeDeclined(input: { changedLines: number; maxChangedLines: number }): Promise<void> {
    this.scopeDeclines.push({
      changedLines: input.changedLines,
      maxChangedLines: input.maxChangedLines,
    });
  }
}

class FakeDiffInspector implements ReviewDiffInspector {
  calls: {
    target: Parameters<ReviewDiffInspector['changedLineCount']>[0];
    ignorePatterns: Parameters<ReviewDiffInspector['changedLineCount']>[1];
  }[] = [];

  constructor(private readonly changedLines: number) {}

  async changedLineCount(
    target: Parameters<ReviewDiffInspector['changedLineCount']>[0],
    ignorePatterns?: Parameters<ReviewDiffInspector['changedLineCount']>[1],
  ): Promise<number> {
    this.calls.push({ target, ignorePatterns });
    return this.changedLines;
  }
}

class FakeRunner implements ReviewAgentRunner {
  calls: Array<Parameters<ReviewAgentRunner['runAgent']>[0]> = [];

  constructor(private readonly stdout: string) {}

  async runAgent(input: Parameters<ReviewAgentRunner['runAgent']>[0]): Promise<string> {
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
