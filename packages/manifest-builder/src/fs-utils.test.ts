import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepoFileSnapshot, listRepoFiles, readRepoText } from './fs-utils.js';

const execFileAsync = promisify(execFile);
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

  it('ignores ambient Git repository and config overrides', async () => {
    const repo = await makeRepo();
    const config = join(root, 'host-config');
    await writeFile(config, 'INVALID GLOBAL GIT CONFIG');
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    };
    try {
      process.env.GIT_DIR = join(root, 'untrusted-git-dir');
      process.env.GIT_WORK_TREE = join(root, 'outside');
      process.env.GIT_CONFIG_GLOBAL = config;
      expect(await readRepoText(repo, 'src/index.ts')).toBe('PINNED_SOURCE_CONTENT');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

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

async function makeRepo(): Promise<string> {
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'index.ts'), 'PINNED_SOURCE_CONTENT');
  await execFileAsync('git', ['init', '-q', repo]);
  await commit(repo);
  return repo;
}

async function commit(repo: string): Promise<void> {
  await execFileAsync('git', ['-C', repo, 'add', '.']);
  await execFileAsync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'Fixture',
  ]);
}
