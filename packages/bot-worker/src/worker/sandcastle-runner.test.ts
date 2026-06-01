import type { AgentProvider, RunOptions, RunResult, SandboxProvider } from '@ai-hero/sandcastle';
import type { AgentDefinition } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import {
  buildReviewPrompt,
  SANDY_WORKER_CONTAINER_PREFIX,
  SandcastleRunner,
} from './sandcastle-runner.js';

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
  it('runs an Agent in an Apple Container against the review worktree', async () => {
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

    const stdout = await runner.runAgent({
      agent: logicAgent,
      worktreePath: '/tmp/sandy/worktrees/job-1',
      signal: abortController.signal,
      botConfig: {
        repoRules: '- Keep widget cache keys tenant-scoped.',
        productRules: '- API errors expose stable codes.',
        ignorePatterns: ['generated/**'],
      },
      pullRequest: {
        owner: 'acme',
        repo: 'widget',
        number: 12,
        headSha: 'abc123',
        baseRef: 'main',
        title: 'Fix cache key',
        url: 'https://github.com/acme/widget/pull/12',
      },
      apiSurfaceManifest: '# API Surface Manifest\n\n## acme/widget\n\n### npm Exports\n',
      siblingWorktrees: [
        {
          repo: 'acme/desktop',
          sha: 'def456',
          hostPath: '/tmp/sandy/worktrees/desktop/job-1',
          sandboxPath: '/workspace/acme/desktop',
        },
      ],
    });

    expect(stdout).toBe('<findings>{"findings":[]}</findings>');
    expect(createAppleContainerCalls).toEqual([
      expect.objectContaining({
        imageName: 'sandy-agent',
        containerNamePrefix: SANDY_WORKER_CONTAINER_PREFIX,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
        mounts: expect.arrayContaining([
          expect.objectContaining({ sandboxPath: '/home/agent/.opensrc' }),
          expect.objectContaining({
            hostPath: '/tmp/sandy/worktrees/desktop/job-1',
            sandboxPath: '/workspace/acme/desktop',
            readonly: true,
          }),
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
    expect(runCalls[0]?.prompt).toContain('# API Surface Manifest');
    expect(runCalls[0]?.prompt).toContain('Use this manifest as a trigger');
    expect(runCalls[0]?.prompt).toContain('Sibling Repo mounts');
    expect(runCalls[0]?.prompt).toContain('/workspace/acme/desktop -> acme/desktop');
    expect(runCalls[0]?.prompt).toContain('Primary trigger');
    expect(runCalls[0]?.prompt).toContain('Secondary diff-judgment trigger');
    expect(runCalls[0]?.prompt).toContain('CSS-only, test-only');
    expect(runCalls[0]?.prompt).toContain('tree_sitter_query');
    expect(runCalls[0]?.prompt).toContain('"crossRepoSearch"');
    expect(runCalls[0]?.prompt).toContain('"trigger": "manifest" | "diff-judgment" | "none"');
    expect(runCalls[0]?.prompt).toContain('Product Rules');
    expect(runCalls[0]?.prompt).toContain('- API errors expose stable codes.');
    expect(runCalls[0]?.prompt).toContain('Repo-local Rules');
    expect(runCalls[0]?.prompt).toContain('- Keep widget cache keys tenant-scoped.');
    expect(runCalls[0]?.prompt).toContain('generated/**');
    expect(runCalls[0]?.prompt).toContain('Agent priors and active Rules');
    expect(runCalls[0]?.prompt).not.toContain('Framework source verification');
    expect(runCalls[0]?.prompt).toContain('<findings>');
  });

  it('adds the source verification contract for opensrc-enabled Agents', () => {
    const prompt = buildReviewPrompt({
      agent: { ...logicAgent, key: 'nextjs', tools: ['read_file', 'rg', 'opensrc'] },
      worktreePath: '/tmp/sandy/worktrees/job-1',
      pullRequest: {
        owner: 'acme',
        repo: 'widget',
        number: 12,
        headSha: 'abc123',
        baseRef: 'main',
        title: 'Fix cache key',
        url: 'https://github.com/acme/widget/pull/12',
      },
      apiSurfaceManifest: '## Framework Versions\n\n- next: 16.0.0',
    });

    expect(prompt).toContain('Framework source verification');
    expect(prompt).toContain('Before emitting a Finding whose correctness depends on framework');
    expect(prompt).toContain('Record the verification in the Finding.evidence');
    expect(prompt).toContain('Memory or generic training knowledge is not evidence');
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
