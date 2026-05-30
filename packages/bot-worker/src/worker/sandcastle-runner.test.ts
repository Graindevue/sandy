import type { AgentProvider, RunOptions, RunResult, SandboxProvider } from '@ai-hero/sandcastle';
import type { AgentDefinition } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import { SANDY_WORKER_CONTAINER_PREFIX, SandcastleRunner } from './sandcastle-runner.js';

const logicAgent: AgentDefinition = {
  key: 'logic',
  name: 'logic',
  description: 'Reviews logic bugs.',
  category: 'logic',
  vendor: 'claude',
  model: 'opus',
  tools: ['read_file', 'rg'],
  maxIterations: 7,
  completionSignal: '</findings>',
  defaultEnabled: true,
  systemPrompt: '# Logic Agent\n\nEmit <findings>{"findings":[]}</findings>.',
};

describe('SandcastleRunner', () => {
  it('runs the logic Agent in an Apple Container against the review worktree', async () => {
    const runCalls: RunOptions[] = [];
    const createAppleContainerCalls: unknown[] = [];
    const sandbox = fakeSandbox();
    const provider = fakeAgentProvider('claude');
    const abortController = new AbortController();

    const runner = new SandcastleRunner({
      imageName: 'sandy-agent',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      run: async (options) => {
        runCalls.push(options);
        return { stdout: '<findings>{"findings":[]}</findings>' } as RunResult;
      },
      createAppleContainer: (options) => {
        createAppleContainerCalls.push(options);
        return sandbox;
      },
      createAgentProvider: () => provider,
    });

    const stdout = await runner.runLogicAgent({
      agent: logicAgent,
      worktreePath: '/tmp/sandy/worktrees/job-1',
      signal: abortController.signal,
      pullRequest: {
        owner: 'acme',
        repo: 'widget',
        number: 12,
        headSha: 'abc123',
        baseRef: 'main',
        title: 'Fix cache key',
        url: 'https://github.com/acme/widget/pull/12',
      },
    });

    expect(stdout).toBe('<findings>{"findings":[]}</findings>');
    expect(createAppleContainerCalls).toEqual([
      expect.objectContaining({
        imageName: 'sandy-agent',
        containerNamePrefix: SANDY_WORKER_CONTAINER_PREFIX,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
        mounts: expect.arrayContaining([
          expect.objectContaining({ sandboxPath: '/home/agent/.opensrc' }),
        ]),
      }),
    ]);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({
      agent: provider,
      sandbox,
      cwd: '/tmp/sandy/worktrees/job-1',
      branchStrategy: { type: 'head' },
      maxIterations: 7,
      completionSignal: '</findings>',
      name: 'logic',
      signal: abortController.signal,
    });
    expect(runCalls[0]?.prompt).toContain('PR #12: Fix cache key');
    expect(runCalls[0]?.prompt).toContain('<findings>');
  });
});

function fakeAgentProvider(name: string): AgentProvider {
  return {
    name,
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: 'echo ok' }),
    parseStreamLine: () => [],
  };
}

function fakeSandbox(): SandboxProvider {
  return {
    tag: 'bind-mount',
    name: 'apple-container',
    env: {},
    sandboxHomedir: '/home/agent',
    create: async () => {
      throw new Error('not used by this test');
    },
  };
}
