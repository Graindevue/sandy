import type { AgentProvider, RunOptions, SandboxProvider } from '@ai-hero/sandcastle';
import type { AgentDefinition } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import {
  aggregateAgentRunUsage,
  buildReviewPrompt,
  createAgentProvider,
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
        return { stdout: '<findings>{"findings":[]}</findings>', iterations: [] };
      },
      createAppleContainer: (options) => {
        createAppleContainerCalls.push(options);
        return sandbox;
      },
      createAgentProvider: () => provider,
    });

    const result = await runner.runAgent({
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

    expect(result.stdout).toBe('<findings>{"findings":[]}</findings>');
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

  it('surfaces aggregated usage from Sandcastle iterations', async () => {
    const runner = new SandcastleRunner({
      run: async () => ({
        stdout: '<findings>{"findings":[]}</findings>',
        iterations: [
          {
            usage: {
              inputTokens: 10,
              cacheCreationInputTokens: 20,
              cacheReadInputTokens: 30,
              outputTokens: 40,
            },
          },
          {},
          {
            usage: {
              inputTokens: 1,
              cacheCreationInputTokens: 2,
              cacheReadInputTokens: 3,
              outputTokens: 4,
            },
          },
        ],
      }),
      createAppleContainer: () => fakeSandbox(),
      createAgentProvider: () => fakeAgentProvider('claude'),
    });

    await expect(
      runner.runAgent({
        agent: logicAgent,
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
      }),
    ).resolves.toEqual({
      stdout: '<findings>{"findings":[]}</findings>',
      usage: {
        inputTokens: 11,
        cacheCreationInputTokens: 22,
        cacheReadInputTokens: 33,
        outputTokens: 44,
      },
    });
  });
});

describe('aggregateAgentRunUsage', () => {
  it('sums usage across iterations', () => {
    expect(
      aggregateAgentRunUsage([
        {
          usage: {
            inputTokens: 100,
            cacheCreationInputTokens: 200,
            cacheReadInputTokens: 300,
            outputTokens: 400,
          },
        },
        {
          usage: {
            inputTokens: 1,
            cacheCreationInputTokens: 2,
            cacheReadInputTokens: 3,
            outputTokens: 4,
          },
        },
      ]),
    ).toEqual({
      inputTokens: 101,
      cacheCreationInputTokens: 202,
      cacheReadInputTokens: 303,
      outputTokens: 404,
    });
  });

  it('skips iterations with absent usage', () => {
    expect(
      aggregateAgentRunUsage([
        {},
        {
          usage: {
            inputTokens: 100,
            cacheCreationInputTokens: 200,
            cacheReadInputTokens: 300,
            outputTokens: 400,
          },
        },
        {},
      ]),
    ).toEqual({
      inputTokens: 100,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
      outputTokens: 400,
    });
  });

  it('returns undefined when all iterations omit usage', () => {
    expect(aggregateAgentRunUsage([{}, {}])).toBeUndefined();
  });

  it('returns a single iteration usage unchanged', () => {
    expect(
      aggregateAgentRunUsage([
        {
          usage: {
            inputTokens: 7,
            cacheCreationInputTokens: 8,
            cacheReadInputTokens: 9,
            outputTokens: 10,
          },
        },
      ]),
    ).toEqual({
      inputTokens: 7,
      cacheCreationInputTokens: 8,
      cacheReadInputTokens: 9,
      outputTokens: 10,
    });
  });
});

describe('createAgentProvider', () => {
  function printCommand(agent: AgentDefinition): string {
    const provider = createAgentProvider(agent, {});
    return provider.buildPrintCommand({ prompt: 'review', dangerouslySkipPermissions: true })
      .command;
  }

  it('passes a claude Agent effort to the CLI as --effort', () => {
    expect(printCommand({ ...logicAgent, effort: 'max' })).toContain('--effort max');
  });

  it('passes a codex Agent effort to the CLI as model_reasoning_effort', () => {
    const command = printCommand({
      ...logicAgent,
      vendor: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
    });
    expect(command).toContain('model_reasoning_effort');
    expect(command).toContain('xhigh');
  });

  it('builds the unchanged default command when effort is absent', () => {
    expect(printCommand(logicAgent)).not.toContain('--effort');
    expect(printCommand({ ...logicAgent, vendor: 'codex', model: 'gpt-5.5' })).not.toContain(
      'model_reasoning_effort',
    );
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
