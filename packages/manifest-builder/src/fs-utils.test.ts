import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureGit } from '../../../test-support/git.js';
import {
  createRepoFileSnapshot,
  listRepoFiles,
  RepoFileReadError,
  readRepoText,
} from './fs-utils.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandy-immutable-source-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('repository source snapshots', () => {
  it('fails closed for non-Git directories and nested directories inside another repository', async () => {
    await expect(readRepoText(root, 'credentials.txt')).rejects.toThrow();
    const repo = await makeRepo();
    await expect(readRepoText(join(repo, 'src'), 'index.ts')).rejects.toThrow(
      'root of a Git checkout',
    );
  });

  it('reads the pinned commit after HEAD and the working tree are modified', async () => {
    const repo = await makeRepo();
    const snapshot = await createRepoFileSnapshot(repo);
    await writeFile(join(repo, 'src', 'index.ts'), 'MODIFIED_WORKTREE_CONTENT');
    await commit(repo);
    await writeFile(join(repo, 'untracked.txt'), 'UNTRACKED_CONTENT');

    expect(await snapshot.readText('src/index.ts')).toBe('PINNED_SOURCE_CONTENT');
    expect(snapshot.listFiles()).toEqual(['src/index.ts']);
    expect(await snapshot.readText('untracked.txt')).toBeNull();
    expect(await snapshot.readText('../outside.txt')).toBeNull();
    expect(await createRepoFileSnapshot(repo, snapshot.sha)).toMatchObject({ sha: snapshot.sha });
  });

  it('fails closed when a tracked Git blob is unavailable', async () => {
    const repo = await makeRepo();
    const snapshot = await createRepoFileSnapshot(repo);
    const { stdout } = await fixtureGit(['-C', repo, 'rev-parse', 'HEAD:src/index.ts']);
    const oid = stdout.trim();
    await rm(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    await expect(snapshot.readText('src/index.ts')).rejects.toThrow(RepoFileReadError);
    expect(await snapshot.readText('untracked.txt')).toBeNull();
  });

  it('reads Git objects when an ancestor directory is replaced with an outside symlink', async () => {
    const repo = await makeRepo();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'index.ts'), 'DUMMY_OUTSIDE_HOST_CONTENT');
    await rename(join(repo, 'src'), join(repo, 'original-src'));
    await symlink(outside, join(repo, 'src'));

    expect(await readRepoText(repo, 'src/index.ts')).toBe('PINNED_SOURCE_CONTENT');
    expect(await listRepoFiles(repo)).toEqual(['src/index.ts']);
  });

  it('isolates fixture writes and snapshot reads from ambient Git overrides', async () => {
    const caller = await makeRepo('caller');
    const callerSnapshot = await createRepoFileSnapshot(caller);
    const callerIndex = await readFile(join(caller, '.git', 'index'));
    const callerObjects = await readdir(join(caller, '.git', 'objects'), { recursive: true });
    const config = join(root, 'host-config');
    await writeFile(config, 'INVALID GLOBAL GIT CONFIG');
    const overrides = {
      GIT_DIR: join(caller, '.git'),
      GIT_COMMON_DIR: join(caller, '.git'),
      GIT_WORK_TREE: caller,
      GIT_INDEX_FILE: join(caller, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(caller, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(caller, '.git', 'objects'),
      GIT_CEILING_DIRECTORIES: root,
      GIT_CONFIG_GLOBAL: config,
    };
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, overrides);
      const repo = await makeRepo();
      expect(await readRepoText(repo, 'src/index.ts')).toBe('PINNED_SOURCE_CONTENT');
      await writeFile(join(repo, 'src', 'index.ts'), 'FIXTURE_SECOND_COMMIT');
      await commit(repo);
      expect(await readRepoText(repo, 'src/index.ts')).toBe('FIXTURE_SECOND_COMMIT');
      expect((await createRepoFileSnapshot(caller)).sha).toBe(callerSnapshot.sha);
      expect(await readFile(join(caller, '.git', 'index'))).toEqual(callerIndex);
      expect(await readdir(join(caller, '.git', 'objects'), { recursive: true })).toEqual(
        callerObjects,
      );
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('reads a complete pinned lockfile larger than 16 MiB', async () => {
    const repo = await makeRepo();
    const contents = `lockfileVersion: '9.0'\n${'# dependency entry\n'.repeat(950_000)}# END\n`;
    expect(Buffer.byteLength(contents)).toBeGreaterThan(16 * 1024 * 1024);
    await writeFile(join(repo, 'pnpm-lock.yaml'), contents);
    await commit(repo);
    const snapshot = await createRepoFileSnapshot(repo);
    await writeFile(join(repo, 'pnpm-lock.yaml'), 'MUTABLE_LOCKFILE');
    expect(await snapshot.readText('pnpm-lock.yaml')).toBe(contents);
  });

  it('lists a complete Git tree larger than 16 MiB', async () => {
    const repo = await makeRepo();
    const { stdout: oid } = await fixtureGit(['-C', repo, 'rev-parse', 'HEAD:src/index.ts']);
    // Build Git objects directly so the fixture is independent of OS filename limits.
    const names = Array.from({ length: 4200 }, (_, index) => `${index}-${'x'.repeat(4096)}`);
    const treeInput = names.map((name) => `100644 blob ${oid.trim()}\t${name}\n`).join('');
    expect(Buffer.byteLength(treeInput)).toBeGreaterThan(16 * 1024 * 1024);
    const { stdout: tree } = await fixtureGit(['-C', repo, 'mktree'], treeInput);
    const { stdout: sha } = await fixtureGit([
      '-C',
      repo,
      'commit-tree',
      tree.trim(),
      '-m',
      'Large tree',
    ]);
    const snapshot = await createRepoFileSnapshot(repo, sha.trim());
    expect(snapshot.listFiles()).toEqual([...names].sort());
    expect(await snapshot.readText(names[4199] ?? '')).toBe('PINNED_SOURCE_CONTENT');
  });

  it('fails closed with an explicit diagnostic for a blob exceeding the supported limit', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'oversized.txt'), 'x'.repeat(64 * 1024 * 1024 + 1));
    await commit(repo);
    const snapshot = await createRepoFileSnapshot(repo);
    await expect(snapshot.readText('oversized.txt')).rejects.toThrow(RepoFileReadError);
    await expect(snapshot.readText('oversized.txt')).rejects.toThrow('64 MiB');
  }, 15_000);

  it.each([
    'file',
    'ancestor',
  ])('never reads outside content during concurrent %s symlink swaps', async (kind) => {
    const repo = await makeRepo();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'index.ts'), 'DUMMY_OUTSIDE_HOST_CONTENT');
    const target = kind === 'file' ? join(repo, 'src', 'index.ts') : join(repo, 'src');
    const source = kind === 'file' ? join(outside, 'index.ts') : outside;
    const control = new SharedArrayBuffer(4);
    const worker = new Worker(
      `
      const fs = require('node:fs');
      const { parentPort, workerData } = require('node:worker_threads');
      const { target, source, kind, control } = workerData;
      const signal = new Int32Array(control);
      let swaps = 0;
      parentPort.postMessage('ready');
      while (!Atomics.load(signal, 0)) {
        if (kind === 'file') {
          const stage = target + '.swap';
          fs.writeFileSync(stage, 'MUTABLE_WORKTREE_CONTENT');
          fs.renameSync(stage, target);
          fs.symlinkSync(source, stage);
          fs.renameSync(stage, target);
        } else {
          const stage = target + '.original';
          fs.renameSync(target, stage);
          fs.symlinkSync(source, target);
          fs.unlinkSync(target);
          fs.renameSync(stage, target);
        }
        swaps += 1;
      }
      parentPort.postMessage({ swaps });
      `,
      { eval: true, workerData: { target, source, kind, control } },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });
    try {
      for (let read = 0; read < 12; read += 1) {
        expect(await readRepoText(repo, 'src/index.ts')).toBe('PINNED_SOURCE_CONTENT');
      }
    } finally {
      Atomics.store(new Int32Array(control), 0, 1);
      await new Promise<void>((resolve, reject) => {
        worker.once('exit', () => resolve());
        worker.once('error', reject);
      });
    }
  });
});

async function makeRepo(name = 'repo'): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'index.ts'), 'PINNED_SOURCE_CONTENT');
  await fixtureGit(['init', '-q', repo]);
  await commit(repo);
  return repo;
}

async function commit(repo: string): Promise<void> {
  await fixtureGit(['-C', repo, 'add', '.']);
  await fixtureGit(['-C', repo, 'commit', '-q', '-m', 'Fixture']);
}
