import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureGit } from '../../../../test-support/git.js';
import type { RunnerPullRequest } from './codex-exec-runner.js';
import { readReviewDiff } from './review-diff.js';
import { fixtureBotConfig, logicAgent } from './review-executor.test-support.js';

const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-review-diff-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(...args: string[]): Promise<string> {
  return (await fixtureGit(['-C', root, ...args])).stdout.trim();
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await git('add', '.');
  await git('commit', '--quiet', '-m', message);
  return await git('rev-parse', 'HEAD');
}

function pullRequest(headSha: string, overrides: Partial<RunnerPullRequest> = {}) {
  return {
    owner: 'acme',
    repo: 'widget',
    number: 12,
    headSha,
    baseRef: 'main',
    title: 'Fix cache key',
    url: 'https://github.com/acme/widget/pull/12',
    ...overrides,
  };
}

describe('readReviewDiff', () => {
  let baseSha: string;
  let headSha: string;
  let laterSha: string;

  beforeEach(async () => {
    await git('init', '--quiet', '-b', 'main');
    baseSha = await commit({ 'src/cache.ts': 'export const key = 1;\n' }, 'Base');
    await git('checkout', '--quiet', '-b', 'feature');
    headSha = await commit(
      { 'src/cache.ts': 'export const key = 2;\n', 'generated/client.ts': 'export {};\n' },
      'Head',
    );
    await git('checkout', '--quiet', 'main');
    laterSha = await commit({ 'src/later.ts': 'export const later = 3;\n' }, 'Later');
  });

  it("diffs the head from the fetched base's merge base by default", async () => {
    await git('update-ref', 'refs/remotes/origin/main', laterSha);

    const diff = await readReviewDiff(
      { agent: logicAgent, worktreePath: root, pullRequest: pullRequest(headSha) },
      env,
    );

    expect(diff).toContain('diff --git a/src/cache.ts b/src/cache.ts');
    expect(diff).toContain('+export const key = 2;');
    expect(diff).toContain('diff --git a/generated/client.ts b/generated/client.ts');
    expect(diff).not.toContain('src/later.ts');
  });

  it('diffs from an exact base commit and leaves out ignored paths', async () => {
    const diff = await readReviewDiff(
      {
        agent: logicAgent,
        worktreePath: root,
        pullRequest: pullRequest(headSha, { baseRef: 'origin/main', baseSha: laterSha }),
        botConfig: { ...fixtureBotConfig, ignorePatterns: ['generated/'] },
      },
      env,
    );

    expect(diff).toContain('+export const key = 2;');
    expect(diff).not.toContain('generated/client.ts');
    expect(diff).not.toContain('src/later.ts');
    expect(
      await readReviewDiff(
        {
          agent: logicAgent,
          worktreePath: root,
          pullRequest: pullRequest(baseSha, { baseSha }),
        },
        env,
      ),
    ).toBe('');
  });
});
