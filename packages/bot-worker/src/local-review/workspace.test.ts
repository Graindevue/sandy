import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureGit } from '../../../../test-support/git.js';
import { type ReviewBase, resolveReviewBase } from './git.js';
import { localReviewHome, pathExists } from './home.js';
import { clearInterruptedReviews, LocalCloneManager, mirrorBaseRef } from './workspace.js';

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-local-workspace-')));
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await fixtureGit(['-C', cwd, ...args])).stdout.trim();
}

async function commit(cwd: string, file: string, content: string): Promise<string> {
  await writeFile(join(cwd, file), content);
  await git(cwd, 'add', file);
  await git(cwd, 'commit', '--quiet', '-m', `Write ${file}`);
  return await git(cwd, 'rev-parse', 'HEAD');
}

describe('LocalCloneManager', () => {
  it("checks the head out of a mirror that holds none of the checkout's other work", async () => {
    const seed = join(root, 'seed');
    await git(root, 'init', '--quiet', '-b', 'main', seed);
    const baseSha = await commit(seed, 'a.txt', 'one\n');
    const checkout = join(root, 'checkout');
    await git(root, 'clone', '--quiet', seed, checkout);
    await git(checkout, 'checkout', '--quiet', '-b', 'private');
    const privateSha = await commit(checkout, 'private.txt', 'draft\n');
    await git(checkout, 'checkout', '--quiet', '-b', 'feature', 'main');
    const headSha = await commit(checkout, 'b.txt', 'two\n');
    await writeFile(join(checkout, 'a.txt'), 'stashed\n');
    await git(checkout, 'stash', 'push', '--quiet', '-m', 'unsaved');
    const stashSha = await git(checkout, 'rev-parse', 'refs/stash');
    await git(checkout, 'config', 'sandy.fixture', 'checkout-only');
    await writeFile(join(checkout, 'untracked.txt'), 'draft\n');
    const home = localReviewHome({ SANDY_CLI_HOME: join(root, 'cli') });
    const manager = new LocalCloneManager({
      home,
      reviewId: 'review-1',
      checkoutRoot: checkout,
      originUrl: null,
      reviewed: { owner: 'acme', name: 'widgets' },
      headSha,
      base: await resolveReviewBase(checkout, headSha),
    });
    const repo = { owner: 'Acme', name: 'Widgets', defaultBranch: 'main' };

    const mirror = await manager.ensureCloned(repo);
    const worktree = await manager.createWorktree(repo, { reviewJobId: 'job-1', sha: headSha });

    expect(await manager.resolveDefaultBranchSha(repo)).toBe(baseSha);
    expect(worktree).toEqual({
      repo,
      path: join(home.worktrees, 'job-1', 'Widgets'),
      sha: headSha,
      reviewJobId: 'job-1',
    });
    expect((await readdir(worktree.path)).sort()).toEqual(['.git', 'a.txt', 'b.txt']);
    expect(await readFile(join(worktree.path, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await git(worktree.path, 'diff', '--name-only', 'origin/main...HEAD')).toBe('b.txt');
    expect((await git(mirror, 'for-each-ref', '--format=%(refname)')).split('\n').sort()).toEqual([
      'refs/remotes/origin/main',
      'refs/sandy/head',
    ]);
    for (const sha of [privateSha, stashSha]) {
      await expect(git(mirror, 'cat-file', '-e', `${sha}^{commit}`)).rejects.toThrow();
    }
    await expect(git(mirror, 'config', '--get', 'sandy.fixture')).rejects.toThrow();

    await manager.removeWorktree(worktree);

    expect(await pathExists(join(home.worktrees, 'job-1'))).toBe(false);
    expect(await readdir(home.mirrors)).toEqual([]);
    expect(await git(checkout, 'rev-parse', 'refs/stash')).toBe(stashSha);
    expect(await git(checkout, 'worktree', 'list', '--porcelain')).not.toContain(home.worktrees);
  });
});

describe('mirrorBaseRef', () => {
  const base = (fullRef: string | null): ReviewBase => ({
    label: 'base',
    fullRef,
    sha: 'b'.repeat(40),
    mergeBase: 'b'.repeat(40),
  });

  it.each([
    ['refs/remotes/origin/main', 'refs/remotes/origin/main'],
    ['refs/heads/main', 'refs/heads/main'],
    ['refs/tags/v1', 'refs/tags/v1'],
    ['refs/sandy/head', 'refs/sandy/base'],
    ['refs/notes/commits', 'refs/sandy/base'],
    [null, 'refs/sandy/base'],
  ])('keeps %s as %s', (fullRef, expected) => {
    expect(mirrorBaseRef(base(fullRef))).toBe(expected);
  });
});

describe('clearInterruptedReviews', () => {
  it('drops leftover worktrees and mirrors but keeps sibling clones', async () => {
    const home = localReviewHome({ SANDY_CLI_HOME: join(root, 'cli') });
    for (const path of [
      join(home.worktrees, 'job-1', 'widgets'),
      join(home.mirrors, 'review-1', 'widgets.git'),
      join(home.repos, '.worktrees', 'acme', 'api', 'job-1'),
      join(home.repos, 'acme', 'api'),
    ]) {
      await mkdir(path, { recursive: true });
    }

    await clearInterruptedReviews(home);

    expect(await pathExists(home.worktrees)).toBe(false);
    expect(await pathExists(home.mirrors)).toBe(false);
    expect(await pathExists(join(home.repos, '.worktrees'))).toBe(false);
    expect(await pathExists(join(home.repos, 'acme', 'api'))).toBe(true);
  });
});
