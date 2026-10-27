import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureGit } from '../../../../test-support/git.js';
import {
  checkoutWorktrees,
  hasCommittedChanges,
  parseRemoteRepository,
  readLocalCheckout,
  resolveReviewBase,
  siblingCloneUrl,
  uncommittedEntryCount,
} from './git.js';

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-local-git-')));
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

/** A clone whose `origin/main` is one commit behind `feature`. */
async function clone(): Promise<{ checkout: string; baseSha: string; headSha: string }> {
  const seed = join(root, 'seed');
  await git(root, 'init', '--quiet', '-b', 'main', seed);
  const baseSha = await commit(seed, 'a.txt', 'one\n');
  const checkout = join(root, 'checkout');
  await git(root, 'clone', '--quiet', seed, checkout);
  await git(checkout, 'checkout', '--quiet', '-b', 'feature');
  const headSha = await commit(checkout, 'b.txt', 'two\n');
  return { checkout, baseSha, headSha };
}

describe('readLocalCheckout', () => {
  it('reads the branch, head, and origin of a checkout from a subdirectory', async () => {
    const { checkout, headSha } = await clone();
    await mkdir(join(checkout, 'nested'));

    expect(await readLocalCheckout(join(checkout, 'nested'))).toEqual({
      root: checkout,
      headSha,
      branch: 'feature',
      originUrl: join(root, 'seed'),
    });
  });

  it('reports a detached HEAD as no branch', async () => {
    const { checkout, baseSha } = await clone();
    await git(checkout, 'checkout', '--quiet', '--detach', baseSha);

    expect(await readLocalCheckout(checkout)).toMatchObject({ headSha: baseSha, branch: null });
  });

  it('rejects a directory outside Git and a repository without commits', async () => {
    await expect(readLocalCheckout(root)).rejects.toThrow(
      'Run sandy review inside a Git working tree',
    );
    const empty = join(root, 'empty');
    await git(root, 'init', '--quiet', empty);
    await expect(readLocalCheckout(empty)).rejects.toThrow('HEAD has no commit to review');
  });
});

describe('resolveReviewBase', () => {
  it('defaults to the branch origin/HEAD names', async () => {
    const { checkout, baseSha, headSha } = await clone();

    expect(await resolveReviewBase(checkout, headSha)).toEqual({
      label: 'origin/main',
      fullRef: 'refs/remotes/origin/main',
      sha: baseSha,
      mergeBase: baseSha,
    });
  });

  it('prefers the remote-tracking branch over a stale local branch of the same name', async () => {
    const { checkout, baseSha, headSha } = await clone();
    await git(checkout, 'checkout', '--quiet', 'main');
    await commit(checkout, 'local.txt', 'unpushed\n');
    await git(checkout, 'checkout', '--quiet', 'feature');

    expect(await resolveReviewBase(checkout, headSha, 'main')).toMatchObject({
      label: 'origin/main',
      sha: baseSha,
    });
    expect(await resolveReviewBase(checkout, headSha, 'refs/heads/main')).toMatchObject({
      label: 'main',
      fullRef: 'refs/heads/main',
    });
  });

  it('accepts tags and revision expressions as given', async () => {
    const { checkout, baseSha, headSha } = await clone();
    await git(checkout, 'tag', 'v1', baseSha);

    expect(await resolveReviewBase(checkout, headSha, 'v1')).toEqual({
      label: 'v1',
      fullRef: 'refs/tags/v1',
      sha: baseSha,
      mergeBase: baseSha,
    });
    expect(await resolveReviewBase(checkout, headSha, 'HEAD~1')).toEqual({
      label: 'HEAD~1',
      fullRef: null,
      sha: baseSha,
      mergeBase: baseSha,
    });
  });

  it('rejects option-like, unknown, and unrelated bases', async () => {
    const { checkout, headSha } = await clone();
    await git(checkout, 'checkout', '--quiet', '--orphan', 'unrelated');
    await commit(checkout, 'c.txt', 'three\n');
    await git(checkout, 'checkout', '--quiet', 'feature');

    await expect(resolveReviewBase(checkout, headSha, '--output=x')).rejects.toThrow(
      '--branch must name a branch, tag, or commit',
    );
    await expect(resolveReviewBase(checkout, headSha, 'missing')).rejects.toThrow(
      'Base missing does not resolve to a commit',
    );
    await expect(resolveReviewBase(checkout, headSha, 'unrelated')).rejects.toThrow(
      'unrelated shares no history with HEAD',
    );
  });

  it('asks for --branch when origin has no default branch', async () => {
    const repo = join(root, 'local');
    await git(root, 'init', '--quiet', '-b', 'main', repo);
    const headSha = await commit(repo, 'a.txt', 'one\n');

    await expect(resolveReviewBase(repo, headSha)).rejects.toThrow(
      'No base found at origin/HEAD, origin/main, or origin/master; pass --branch <base>',
    );
  });
});

describe('working tree state', () => {
  it('detects committed changes against the merge base only', async () => {
    const { checkout, baseSha, headSha } = await clone();

    expect(await hasCommittedChanges(checkout, baseSha, headSha)).toBe(true);
    expect(await hasCommittedChanges(checkout, headSha, headSha)).toBe(false);
  });

  it('counts modified, untracked, and renamed entries once each', async () => {
    const { checkout } = await clone();
    await writeFile(join(checkout, 'a.txt'), 'changed\n');
    await writeFile(join(checkout, 'new.txt'), 'new\n');
    await git(checkout, 'mv', 'b.txt', 'renamed.txt');

    expect(await uncommittedEntryCount(checkout)).toBe(3);
  });

  it('lists the main checkout and its linked worktrees', async () => {
    const { checkout } = await clone();
    const linked = join(root, 'linked');
    await git(checkout, 'worktree', 'add', '--quiet', '-b', 'other', linked);

    expect(await checkoutWorktrees(checkout)).toEqual([checkout, linked]);
  });
});

describe('parseRemoteRepository', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme', 'widgets'],
    ['https://x-access-token:token@github.com/acme/widgets', 'acme', 'widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme', 'widgets'],
    ['git@github.com:acme/widgets.git', 'acme', 'widgets'],
    ['https://git.example.test/group/acme/widgets.git/', 'acme', 'widgets'],
    ['/srv/git/acme/widgets.git', 'acme', 'widgets'],
  ])('reads %s', (remote, owner, name) => {
    expect(parseRemoteRepository(remote)).toEqual({ owner, name });
  });

  it.each(['widgets', 'https://github.com/widgets', 'git@github.com:widgets.git', '/srv/acme/..'])(
    'rejects %s',
    (remote) => {
      expect(parseRemoteRepository(remote)).toBeNull();
    },
  );
});

describe('siblingCloneUrl', () => {
  const sibling = { owner: 'acme', name: 'api' };

  it.each([
    [null, 'https://github.com/acme/api.git'],
    ['https://github.com/acme/widgets.git', 'https://github.com/acme/api.git'],
    [
      'https://x-access-token:token@github.com/acme/widgets.git?ref=1#top',
      'https://github.com/acme/api.git',
    ],
    ['ssh://git@github.com/acme/widgets.git', 'ssh://git@github.com/acme/api.git'],
    ['git@github.com:acme/widgets.git', 'git@github.com:acme/api.git'],
    ['git@github.com:acme/widgets', 'git@github.com:acme/api'],
    ['/srv/git/acme/widgets.git', '/srv/git/acme/api.git'],
    ['https://github.com/widgets', 'https://github.com/acme/api.git'],
  ])('derives the sibling URL from %s', (origin, expected) => {
    expect(siblingCloneUrl(origin, sibling)).toBe(expected);
  });
});
