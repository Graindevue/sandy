import type { AgentDefinition } from '@sandy/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunError } from './review-errors.js';
import { type ReviewAgentRuntime, ReviewExecutor } from './review-executor.js';
import {
  agentRunUsage,
  deferred,
  FakeArchetypeAssigner,
  FakeCloneManager,
  FakeDiffInspector,
  FakeExecutionStore,
  FakePoster,
  finding,
  findingsOutput,
  fixtureExecutorOptions,
  logicAgent,
  makeContext,
  runnerOutput,
  securityAgent,
  securityFinding,
  withTimeout,
} from './review-executor.test-support.js';

describe('claimed ReviewJob concurrency', () => {
  it('uses the shared prepared worktree in serial rollback without private copies', async () => {
    const paths: string[] = [];
    const fixture = managedReview({
      cap: 1,
      onOpen: (privatePaths) => expect(privatePaths).toEqual([]),
      runAgent: async ({ worktreePath }) => {
        paths.push(worktreePath);
        return runnerOutput(findingsOutput([]));
      },
    });
    fixture.clones.materializeAgentWorkspace = async () => {
      throw new Error('Serial rollback must not copy the prepared installation');
    };
    await fixture.executor.executeClaimedJob('job-1');
    expect(paths).toEqual(['/tmp/worktree/acme/widget/job-1', '/tmp/worktree/acme/widget/job-1']);
    expect(fixture.store.agentRuns.every((run) => run.status === 'completed')).toBe(true);
    expect(fixture.clones.removed).toHaveLength(1);
    expect(fixture.store.status).toBe('completed');
  });

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
      ...fixtureExecutorOptions,
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

  it('retains completed findings and explicitly fails queued Agents after a fatal runtime failure', async () => {
    const failed = new AbortController();
    const starts: string[] = [];
    const custom = { ...logicAgent, key: 'custom', name: 'custom' };
    const fixture = managedReview({
      agents: [logicAgent, securityAgent, custom],
      cap: 1,
      failureSignal: failed.signal,
      runAgent: async ({ agent }) => {
        starts.push(agent.key);
        if (agent.key === 'security') {
          const error = new Error('app-server transport closed');
          failed.abort(error);
          throw error;
        }
        return runnerOutput(findingsOutput([finding]));
      },
    });
    await fixture.executor.executeClaimedJob('job-1');
    expect(starts).toEqual(['logic', 'security']);
    expect(fixture.store.agentRuns.map(({ agentKey, status }) => ({ agentKey, status }))).toEqual([
      { agentKey: 'logic', status: 'completed' },
      { agentKey: 'security', status: 'failed' },
      { agentKey: 'custom', status: 'failed' },
    ]);
    expect(fixture.store.recordedFindings).toHaveLength(1);
    expect(fixture.poster.results[0]?.summary).toContain(
      'Partial Review: 2 of 3 selected Agents failed',
    );
  });

  it('cancels active and queued work and waits for children and runtime shutdown before removing workspaces', async () => {
    const cancellation = new AbortController();
    const started = deferred<void>();
    const interrupted = deferred<void>();
    const drained = deferred<void>();
    const closing = deferred<void>();
    const closed = deferred<void>();
    const starts: string[] = [];
    const fixture = managedReview({
      cap: 1,
      signal: cancellation.signal,
      runAgent: async ({ agent, signal }) => {
        starts.push(agent.key);
        started.resolve();
        await new Promise<void>((resolve) =>
          signal?.addEventListener(
            'abort',
            () => {
              interrupted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
        await drained.promise;
        throw signal?.reason;
      },
      close: async () => {
        closing.resolve();
        await closed.promise;
      },
    });
    const reviewing = fixture.executor.executeClaimedJob('job-1');
    try {
      await started.promise;
      cancellation.abort(new Error('Review deadline expired'));
      await interrupted.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fixture.clones.removed).toEqual([]);
      expect(starts).toEqual(['logic']);
      let hasStartedClosing = false;
      void closing.promise.then(() => {
        hasStartedClosing = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hasStartedClosing).toBe(false);
      drained.resolve();
      await closing.promise;
      expect(fixture.clones.removed).toEqual([]);
    } finally {
      drained.resolve();
      closed.resolve();
      await reviewing;
    }
    expect(fixture.poster.results).toEqual([]);
    expect(fixture.store.status).toBe('failed');
    expect(fixture.clones.removed).toHaveLength(1);
  });

  it('bounds fan-out and gives queued Agents a full timeout budget after admission', async () => {
    vi.useFakeTimers();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const thirdStarted = deferred<void>();
    const finishSecond = deferred<void>();
    const finish = deferred<void>();
    const starts: string[] = [];
    const signals = new Map<string, AbortSignal | undefined>();
    const custom = { ...logicAgent, key: 'custom', name: 'custom' };
    const fixture = managedReview({
      agents: [logicAgent, securityAgent, custom],
      cap: 2,
      agentTimeoutMs: 100,
      runAgent: async ({ agent, signal }) => {
        starts.push(agent.key);
        signals.set(agent.key, signal);
        if (agent.key === 'logic') {
          firstStarted.resolve();
          await new Promise<void>((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        } else {
          (agent.key === 'security' ? secondStarted : thirdStarted).resolve();
          await (agent.key === 'security' ? finishSecond.promise : finish.promise);
        }
        return runnerOutput(findingsOutput([]));
      },
    });
    const reviewing = fixture.executor.executeClaimedJob('job-1');
    try {
      await firstStarted.promise;
      await secondStarted.promise;
      expect(starts).toEqual(['logic', 'security']);
      await vi.advanceTimersByTimeAsync(60);
      finishSecond.resolve();
      await thirdStarted.promise;
      await vi.advanceTimersByTimeAsync(50);
      expect(starts).toEqual(['logic', 'security', 'custom']);
      expect(signals.get('custom')?.aborted).toBe(false);
      expect(fixture.store.agentRuns.find((run) => run.agentKey === 'logic')?.status).toBe(
        'timed_out',
      );
    } finally {
      finishSecond.resolve();
      finish.resolve();
      await reviewing;
      vi.useRealTimers();
    }
    expect(fixture.store.agentRuns.filter((run) => run.status === 'completed')).toHaveLength(2);
  });

  it('interrupts a superseded Review even while all active Agents are waiting', async () => {
    vi.useFakeTimers();
    const cleanup = new AbortController();
    const started = deferred<void>();
    let interrupted = false;
    const fixture = managedReview({
      cap: 1,
      signal: cleanup.signal,
      runAgent: async ({ signal }) => {
        started.resolve();
        return new Promise<never>((_resolve, reject) =>
          signal?.addEventListener(
            'abort',
            () => {
              interrupted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    });
    const reviewing = fixture.executor.executeClaimedJob('job-1');
    try {
      await started.promise;
      fixture.store.status = 'superseded';
      await vi.advanceTimersByTimeAsync(1000);
      expect(interrupted).toBe(true);
    } finally {
      cleanup.abort(new Error('test cleanup'));
      await reviewing;
      vi.useRealTimers();
    }
    expect(fixture.poster.results).toEqual([]);
    expect(fixture.store.status).toBe('superseded');
    expect(fixture.clones.removed).toHaveLength(1);
  });

  it('records authoritative usage on failed Agents without borrowing successful peer usage', async () => {
    const fixture = managedReview({
      runAgent: async ({ agent }) => {
        if (agent.key === 'logic')
          throw new AgentRunError('malformed terminal response', agentRunUsage);
        return runnerOutput(findingsOutput([]), { ...agentRunUsage, inputTokens: 500 });
      },
    });
    await fixture.executor.executeClaimedJob('job-1');
    expect(fixture.store.agentRuns.find((run) => run.agentKey === 'logic')).toMatchObject({
      status: 'failed',
      usage: agentRunUsage,
    });
    expect(
      fixture.store.agentRuns.find((run) => run.agentKey === 'security')?.usage?.inputTokens,
    ).toBe(500);
  });
  it('preserves completed Findings but reports runtime shutdown failure as an operational failure', async () => {
    const fixture = managedReview({
      runAgent: async ({ agent }) =>
        runnerOutput(findingsOutput(agent.key === 'logic' ? [finding] : [])),
      close: async () => {
        throw new Error('could not finalize runtime state');
      },
    });
    await fixture.executor.executeClaimedJob('job-1');
    expect(fixture.store.recordedFindings).toHaveLength(1);
    expect(fixture.store.status).toBe('failed');
    expect(fixture.store.failed[0]?.error).toContain('runtime shutdown');
  });

  it('provides the complete private workspace inventory before any runtime thread can start', async () => {
    let inventory: readonly string[] | undefined;
    const fixture = managedReview({
      onOpen: (paths) => {
        inventory = paths;
      },
      runAgent: async () => runnerOutput(findingsOutput([])),
    });
    await fixture.executor.executeClaimedJob('job-1');
    expect(inventory).toEqual([
      '/tmp/worktree/acme/widget/job-1-logic',
      '/tmp/worktree/acme/widget/job-1-security',
    ]);
  });

  it('retains final per-thread usage drained after an individual timeout', async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const fixture = managedReview({
      agentTimeoutMs: 100,
      runAgent: async ({ agent, signal }) => {
        if (agent.key === 'security') return runnerOutput(findingsOutput([]));
        started.resolve();
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new AgentRunError('turn interrupted', agentRunUsage);
      },
    });
    const reviewing = fixture.executor.executeClaimedJob('job-1');
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(100);
      await reviewing;
    } finally {
      vi.useRealTimers();
    }
    expect(fixture.store.agentRuns.find((run) => run.agentKey === 'logic')).toMatchObject({
      status: 'timed_out',
      usage: agentRunUsage,
    });
  });
});

function managedReview(options: {
  agents?: AgentDefinition[];
  cap?: number;
  signal?: AbortSignal;
  failureSignal?: AbortSignal;
  close?: () => Promise<void>;
  runAgent: ReviewAgentRuntime['runAgent'];
  agentTimeoutMs?: number;
  onOpen?: (paths: readonly string[] | undefined) => void;
}) {
  const agents = options.agents ?? [logicAgent, securityAgent];
  const store = new FakeExecutionStore(
    makeContext({ agentKeys: agents.map((agent) => agent.key) }),
  );
  const poster = new FakePoster();
  const clones = Object.assign(new FakeCloneManager(), {
    materializeAgentWorkspace: async (
      seed: Awaited<ReturnType<FakeCloneManager['createWorktree']>>,
      key: string,
    ) => ({ ...seed, path: `${seed.path}-${key}`, reviewJobId: `${seed.reviewJobId}-${key}` }),
  });
  const executor = new ReviewExecutor({
    ...fixtureExecutorOptions,
    store,
    cloneManager: clones,
    poster,
    archetypeAssigner: new FakeArchetypeAssigner(),
    diffInspector: new FakeDiffInspector(42),
    maxAgentConcurrency: options.cap ?? 2,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: options.agentTimeoutMs }),
    runner: {
      runAgent: async () => {
        throw new Error('legacy runner must not be used');
      },
      openReview: async ({ privateWorkspacePaths }) => {
        options.onOpen?.(privateWorkspacePaths);
        return {
          mode: (options.cap ?? 2) === 1 ? 'serial' : 'parallel',
          maxConcurrency: options.cap ?? 2,
          ...(options.failureSignal === undefined ? {} : { failureSignal: options.failureSignal }),
          runAgent: options.runAgent,
          close: options.close ?? (async () => {}),
        };
      },
    },
    resolveAgents: () => agents,
    resolveAgent: () => logicAgent,
  });
  return { executor, store, poster, clones };
}
