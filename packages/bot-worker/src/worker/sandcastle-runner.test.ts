import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentProvider,
  BindMountCreateOptions,
  ExecResult,
  RunOptions,
  SandboxProvider,
} from '@ai-hero/sandcastle';
import type { AgentDefinition } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import type { RunAgentInput, RunnerPullRequest } from './sandcastle-runner.js';
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
const reviewWorktreePath = '/tmp/sandy/worktrees/job-1';
const reviewPullRequest: RunnerPullRequest = {
  owner: 'acme',
  repo: 'widget',
  number: 12,
  headSha: 'abc123',
  baseRef: 'main',
  title: 'Fix cache key',
  url: 'https://github.com/acme/widget/pull/12',
};

function reviewPromptInput(agent: AgentDefinition): RunAgentInput {
  return {
    agent,
    worktreePath: reviewWorktreePath,
    pullRequest: reviewPullRequest,
  };
}

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
      worktreePath: reviewWorktreePath,
      signal: abortController.signal,
      botConfig: {
        repoRules: '- Keep widget cache keys tenant-scoped.',
        productRules: '- API errors expose stable codes.',
        ignorePatterns: ['generated/**'],
      },
      pullRequest: reviewPullRequest,
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
        env: {
          npm_config_manage_package_manager_versions: 'false',
          npm_config_store_dir: '/home/agent/.local/share/pnpm/store',
          ANTHROPIC_API_KEY: 'sk-test',
        },
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
      ...reviewPromptInput({ ...logicAgent, key: 'nextjs', tools: ['read_file', 'rg', 'opensrc'] }),
      apiSurfaceManifest: '## Framework Versions\n\n- next: 16.0.0',
    });

    expect(prompt).toContain('Framework source verification');
    expect(prompt).toContain('Before emitting a Finding whose correctness depends on framework');
    expect(prompt).toContain('Record the verification in the Finding.evidence');
    expect(prompt).toContain('Memory or generic training knowledge is not evidence');
  });

  it('adds token-discipline guidance for every Agent prompt', () => {
    const prompts = [
      buildReviewPrompt(reviewPromptInput(logicAgent)),
      buildReviewPrompt(
        reviewPromptInput({ ...logicAgent, key: 'nextjs', tools: ['read_file', 'rg', 'opensrc'] }),
      ),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('Token discipline');
      expect(prompt).toContain('Prefer locating symbols with search (`rg`) before opening files');
      expect(prompt).toContain('Prefer reading focused line ranges over whole files');
      expect(prompt).toContain('Prefer running the narrowest relevant test');
      expect(prompt).toContain('Avoid pasting full command logs');
      expect(prompt).toContain('preserve exact file paths, line numbers, and error text');
    }
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

describe('SandcastleRunner.installDependencies', () => {
  async function makeWorktree(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sandy-runner-install-'));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return dir;
  }

  interface InstallHarness {
    runner: SandcastleRunner;
    createCalls: unknown[];
    createOptions: BindMountCreateOptions[];
    execCommands: string[];
    closeCount: () => number;
  }

  function makeHarness(
    execResult: ExecResult | (() => Promise<ExecResult>),
    options: { installTimeoutMs?: number; nodeModulesCacheDir?: string } = {},
  ): InstallHarness {
    const createCalls: unknown[] = [];
    const createOptions: BindMountCreateOptions[] = [];
    const execCommands: string[] = [];
    let closed = 0;

    const provider: SandboxProvider = {
      tag: 'bind-mount',
      name: 'apple-container',
      env: {},
      sandboxHomedir: '/home/agent',
      create: async (create: BindMountCreateOptions) => {
        createOptions.push(create);
        return {
          worktreePath: '/home/agent/workspace',
          exec: async (command: string) => {
            execCommands.push(command);
            return typeof execResult === 'function' ? await execResult() : execResult;
          },
          copyFileIn: async () => {},
          copyFileOut: async () => {},
          close: async () => {
            closed += 1;
          },
        };
      },
    };

    const runner = new SandcastleRunner({
      imageName: 'sandy-agent',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      ...(options.installTimeoutMs !== undefined
        ? { installTimeoutMs: options.installTimeoutMs }
        : {}),
      ...(options.nodeModulesCacheDir !== undefined
        ? { nodeModulesCacheDir: options.nodeModulesCacheDir }
        : {}),
      createAppleContainer: (containerOptions) => {
        createCalls.push(containerOptions);
        return provider;
      },
      createAgentProvider: () => fakeAgentProvider('claude'),
    });

    return { runner, createCalls, createOptions, execCommands, closeCount: () => closed };
  }

  it('runs the detected install in a one-shot VM on the worktree', async () => {
    const worktreePath = await makeWorktree({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const harness = makeHarness({ stdout: 'done', stderr: '', exitCode: 0 });

    try {
      const result = await harness.runner.installDependencies({ worktreePath });

      expect(result).toEqual({
        status: 'installed',
        packageManager: 'pnpm',
        command: 'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline',
        durationMs: expect.any(Number),
      });
      expect(harness.execCommands).toEqual([
        'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline',
      ]);
      expect(harness.createCalls).toEqual([
        expect.objectContaining({
          imageName: 'sandy-agent',
          containerNamePrefix: SANDY_WORKER_CONTAINER_PREFIX,
        }),
      ]);
      expect(harness.createOptions).toEqual([
        expect.objectContaining({
          worktreePath,
          mounts: [{ hostPath: worktreePath, sandboxPath: '/home/agent/workspace' }],
          env: expect.objectContaining({
            npm_config_manage_package_manager_versions: 'false',
            npm_config_store_dir: '/home/agent/.local/share/pnpm/store',
          }),
        }),
      ]);
      expect(harness.closeCount()).toBe(1);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('mounts the parent gitdir so repo prepare scripts can run git', async () => {
    const worktreePath = await makeWorktree({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      '.git': 'gitdir: /Users/op/.sandy/repos/Acme/widget/.git/worktrees/job-1\n',
    });
    const harness = makeHarness({ stdout: '', stderr: '', exitCode: 0 });

    try {
      await harness.runner.installDependencies({ worktreePath });

      expect(harness.createOptions[0]?.mounts).toEqual([
        { hostPath: worktreePath, sandboxPath: '/home/agent/workspace' },
        {
          hostPath: '/Users/op/.sandy/repos/Acme/widget/.git',
          sandboxPath: '/Users/op/.sandy/repos/Acme/widget/.git',
        },
      ]);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('seeds the worktree from the per-Repo cache and refreshes it after install', async () => {
    const worktreePath = await makeWorktree({ 'package.json': '{}', 'pnpm-lock.yaml': 'deps: v2' });
    const cacheRoot = await mkdtemp(join(tmpdir(), 'sandy-nm-cache-'));
    const seedDir = join(cacheRoot, 'acme', 'widget');
    await mkdir(join(seedDir, 'node_modules'), { recursive: true });
    await writeFile(join(seedDir, 'node_modules', 'seeded.txt'), 'from cache');
    await writeFile(join(seedDir, 'lockfile.sha256'), 'stale-hash\n');

    let nodeModulesSeededAtExecTime = false;
    const harness = makeHarness(
      async () => {
        nodeModulesSeededAtExecTime = await stat(join(worktreePath, 'node_modules', 'seeded.txt'))
          .then(() => true)
          .catch(() => false);
        // The "install" adds a file, as a real lockfile-drift patch would.
        await writeFile(join(worktreePath, 'node_modules', 'installed.txt'), 'from install');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      { nodeModulesCacheDir: cacheRoot },
    );

    try {
      const result = await harness.runner.installDependencies({
        worktreePath,
        cacheKey: 'acme/widget',
      });

      expect(result).toMatchObject({ status: 'installed' });
      expect(nodeModulesSeededAtExecTime).toBe(true);
      // The stale seed was replaced by the post-install tree and re-keyed.
      await expect(readFile(join(seedDir, 'node_modules', 'installed.txt'), 'utf8')).resolves.toBe(
        'from install',
      );
      const recordedHash = (await readFile(join(seedDir, 'lockfile.sha256'), 'utf8')).trim();
      expect(recordedHash).toBe(createHash('sha256').update('deps: v2').digest('hex'));
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('does not refresh the seed cache when the install fails', async () => {
    const worktreePath = await makeWorktree({ 'package.json': '{}', 'pnpm-lock.yaml': 'deps: v3' });
    const cacheRoot = await mkdtemp(join(tmpdir(), 'sandy-nm-cache-'));
    const harness = makeHarness(
      { stdout: '', stderr: 'ERR_PNPM_OUTDATED_LOCKFILE', exitCode: 1 },
      { nodeModulesCacheDir: cacheRoot },
    );

    try {
      await expect(
        harness.runner.installDependencies({ worktreePath, cacheKey: 'acme/widget' }),
      ).resolves.toMatchObject({ status: 'failed' });
      await expect(stat(join(cacheRoot, 'acme', 'widget'))).rejects.toThrow();
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('reports a failed install with the command and the output tail', async () => {
    const worktreePath = await makeWorktree({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const harness = makeHarness({
      stdout: '',
      stderr: 'ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY broken lockfile',
      exitCode: 1,
    });

    try {
      await expect(harness.runner.installDependencies({ worktreePath })).resolves.toEqual({
        status: 'failed',
        command: 'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline',
        error: 'ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY broken lockfile',
      });
      expect(harness.closeCount()).toBe(1);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('skips without creating a VM when no toolchain is detected', async () => {
    const worktreePath = await makeWorktree({ 'README.md': 'not a JS repo' });
    const harness = makeHarness({ stdout: '', stderr: '', exitCode: 0 });

    try {
      await expect(harness.runner.installDependencies({ worktreePath })).resolves.toEqual({
        status: 'skipped',
        reason: 'no package.json or supported lockfile in the worktree',
      });
      expect(harness.createCalls).toEqual([]);
      expect(harness.execCommands).toEqual([]);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('reports a failed install when the command exceeds the install timeout', async () => {
    const worktreePath = await makeWorktree({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const harness = makeHarness(() => new Promise<ExecResult>(() => {}), {
      installTimeoutMs: 20,
    });

    try {
      await expect(harness.runner.installDependencies({ worktreePath })).resolves.toEqual({
        status: 'failed',
        command: 'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline',
        error: 'install exceeded 20ms',
      });
      expect(harness.closeCount()).toBe(1);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('rethrows the abort reason and tears the VM down when cancelled mid-install', async () => {
    const worktreePath = await makeWorktree({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    let execStarted!: () => void;
    const execStartedPromise = new Promise<void>((resolve) => {
      execStarted = resolve;
    });
    const harness = makeHarness(() => {
      execStarted();
      return new Promise<ExecResult>(() => {});
    });
    const abortController = new AbortController();
    const reason = new Error('superseded');

    try {
      const install = harness.runner.installDependencies({
        worktreePath,
        signal: abortController.signal,
      });
      await execStartedPromise;
      abortController.abort(reason);
      await expect(install).rejects.toBe(reason);
      expect(harness.closeCount()).toBe(1);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('rejects without creating a VM when already aborted', async () => {
    const worktreePath = await makeWorktree({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const harness = makeHarness({ stdout: '', stderr: '', exitCode: 0 });
    const abortController = new AbortController();
    const reason = new Error('superseded');
    abortController.abort(reason);

    try {
      await expect(
        harness.runner.installDependencies({
          worktreePath,
          signal: abortController.signal,
        }),
      ).rejects.toBe(reason);
      expect(harness.createOptions).toEqual([]);
      expect(harness.closeCount()).toBe(0);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });
});

describe('buildReviewPrompt sandbox toolchain context', () => {
  it('omits the toolchain section when no install result is present', () => {
    expect(buildReviewPrompt(reviewPromptInput(logicAgent))).not.toContain('Sandbox toolchain');
  });

  it('tells Agents tests are runnable after a successful install', () => {
    const prompt = buildReviewPrompt({
      ...reviewPromptInput(logicAgent),
      dependencyInstall: {
        status: 'installed',
        packageManager: 'pnpm',
        command: 'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline',
        durationMs: 42_000,
      },
    });

    expect(prompt).toContain('Sandbox toolchain');
    expect(prompt).toContain('Dependencies are installed');
    expect(prompt).toContain(
      'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline',
    );
    expect(prompt).toContain('completed in 42s');
    expect(prompt).toContain('Do NOT re-run a dependency install');
  });

  it('warns Agents off package-manager commands when the install failed', () => {
    const prompt = buildReviewPrompt({
      ...reviewPromptInput(logicAgent),
      dependencyInstall: {
        status: 'failed',
        command: 'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline',
        error: 'registry unreachable',
      },
    });

    expect(prompt).toContain('Dependency install FAILED');
    expect(prompt).toContain('registry unreachable');
    expect(prompt).toContain('Do NOT run package-manager or test commands');
    expect(prompt).toContain('mark it unverified');
  });

  it('warns Agents off package-manager commands when the install was skipped', () => {
    const prompt = buildReviewPrompt({
      ...reviewPromptInput(logicAgent),
      dependencyInstall: {
        status: 'skipped',
        reason: 'no package.json or supported lockfile in the worktree',
      },
    });

    expect(prompt).toContain('No dependency install ran for this Review');
    expect(prompt).toContain('Do NOT run package-manager or test commands');
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
