import { describe, expect, it } from 'vitest';
import { ReviewExecutor } from './review-executor.js';
import {
  deferred,
  FakeArchetypeAssigner,
  FakeCloneManager,
  FakeDiffInspector,
  FakeExecutionStore,
  FakePoster,
  finding,
  findingsOutput,
  logicAgent,
  makeContext,
  runnerOutput,
  securityAgent,
  securityFinding,
  withTimeout,
} from './review-executor.test-support.js';

describe('claimed ReviewJob concurrency', () => {
  it('overlaps independent Agents, persists completions promptly, and synthesizes in selected order', async () => {
    const store = new FakeExecutionStore(makeContext({ agentKeys: ['logic', 'security'] }));
    const poster = new FakePoster();
    const logic = deferred<void>();
    const securityStarted = deferred<void>();
    const securityPersisted = deferred<void>();
    const record = store.recordAgentRun.bind(store);
    store.recordAgentRun = async (input) => {
      await record(input);
      if (input.agentKey === 'security') securityPersisted.resolve();
    };
    const workspaces: string[] = [];
    const clones = Object.assign(new FakeCloneManager(), {
      materializeAgentWorkspace: async (
        seed: Awaited<ReturnType<FakeCloneManager['createWorktree']>>,
        key: string,
      ) => ({
        ...seed,
        path: `${seed.path}-${key}`,
        reviewJobId: `${seed.reviewJobId}-${key}`,
      }),
    });
    let closed = false;
    const executor = new ReviewExecutor({
      store,
      cloneManager: clones,
      poster,
      archetypeAssigner: new FakeArchetypeAssigner(),
      diffInspector: new FakeDiffInspector(42),
      maxAgentConcurrency: 2,
      runner: {
        runAgent: async () => {
          throw new Error('legacy runner must not be used');
        },
        openReview: async () => ({
          mode: 'parallel',
          maxConcurrency: 2,
          runAgent: async ({ agent, worktreePath }) => {
            workspaces.push(worktreePath);
            if (agent.key === 'logic') await logic.promise;
            else securityStarted.resolve();
            return runnerOutput(
              findingsOutput(
                [{ ...(agent.key === 'logic' ? finding : securityFinding), agentKey: 'spoofed' }],
                `${agent.key} summary`,
              ),
            );
          },
          close: async () => {
            closed = true;
          },
        }),
      },
      resolveAgents: () => [logicAgent, securityAgent],
      resolveAgent: () => logicAgent,
    });

    const reviewing = executor.executeClaimedJob('job-1');
    try {
      await withTimeout(securityStarted.promise, 250);
      await withTimeout(securityPersisted.promise, 250);
      expect(store.agentRuns.map((run) => run.agentKey)).toEqual(['security']);
      expect(closed).toBe(false);
    } finally {
      logic.resolve();
      await reviewing;
    }
    expect(workspaces).toEqual([
      '/tmp/worktree/acme/widget/job-1-logic',
      '/tmp/worktree/acme/widget/job-1-security',
    ]);
    expect(store.recordedFindings.map(({ finding: output }) => output.agentKey)).toEqual([
      'logic',
      'security',
    ]);
    expect(poster.results[0]?.summary).toMatch(/logic summary[\s\S]*security summary/);
    expect(closed).toBe(true);
    expect(clones.removed).toHaveLength(3);
    expect(store.status).toBe('completed');
  });
});
