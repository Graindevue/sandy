import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloneManager } from './clone-manager.js';

/**
 * Drives the {@link CloneManager} against a real `git` binary and a LOCAL bare
 * origin created under `os.tmpdir()` — never the network. Every temp dir is
 * removed in teardown. The origin's `file://` path stands in for a GitHub clone
 * URL so we exercise actual clone/fetch/worktree plumbing.
 */

const exec = promisify(execFile);

/** A handle to a temporary origin Repo and helpers to mutate it. */
interface Origin {
  /** Path to the bare origin repo (used as the clone URL). */
  url: string;
  /** Append a commit to the origin's default branch; returns its SHA. */
  commit(message: string, file: string, contents: string): Promise<string>;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'sandy-clone-mgr-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/** Create a bare origin plus a working clone we push seed commits through. */
async function makeOrigin(): Promise<Origin> {
  const bare = join(tmpRoot, 'origin.git');
  await exec('git', ['init', '--bare', '--initial-branch=main', bare]);

  const seed = await mkdtemp(join(tmpRoot, 'seed-'));
  await exec('git', ['clone', bare, seed]);
  await exec('git', ['-C', seed, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', seed, 'config', 'user.name', 'Test']);

  const url = bare;
  const commit = async (message: string, file: string, contents: string): Promise<string> => {
    await writeFile(join(seed, file), contents);
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', message);
    await git(seed, 'push', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };

  // Seed an initial commit so the default branch exists.
  await commit('initial', 'README.md', '# seed\n');
  return { url, commit };
}

const REPO = { owner: 'tony-co', name: 'sandy', defaultBranch: 'main' };

describe('CloneManager', () => {
  it('clones a Repo on first observation', async () => {
    const origin = await makeOrigin();
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });

    const repoPath = await manager.ensureCloned(REPO);

    expect(existsSync(join(repoPath, '.git'))).toBe(true);
    expect(existsSync(join(repoPath, 'README.md'))).toBe(true);
    // The clone lives under baseDir, namespaced by owner/name.
    expect(repoPath.startsWith(baseDir)).toBe(true);
    expect(repoPath).toContain('tony-co');
    expect(repoPath).toContain('sandy');
  });

  it('does not re-clone an already-cloned Repo (idempotent)', async () => {
    const origin = await makeOrigin();
    const baseDir = join(tmpRoot, 'repos');
    let cloneCalls = 0;
    const manager = new CloneManager({
      baseDir,
      cloneUrl: () => {
        cloneCalls += 1;
        return origin.url;
      },
    });

    const first = await manager.ensureCloned(REPO);
    const second = await manager.ensureCloned(REPO);

    expect(second).toBe(first);
    // cloneUrl is consulted once: the second call sees the existing clone.
    expect(cloneCalls).toBe(1);
  });

  it('fetches new commits on a later push', async () => {
    const origin = await makeOrigin();
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });

    const repoPath = await manager.ensureCloned(REPO);
    const newSha = await origin.commit('second', 'feature.ts', 'export const x = 1;\n');

    await manager.fetch(REPO);

    // The fetched object is present in the local clone after fetch.
    const type = await git(repoPath, 'cat-file', '-t', newSha);
    expect(type).toBe('commit');
  });

  it('resolves the fetched default branch SHA for sibling manifest worktrees', async () => {
    const origin = await makeOrigin();
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });
    await manager.ensureCloned(REPO);
    const newSha = await origin.commit('second', 'feature.ts', 'export const x = 1;\n');

    await expect(manager.resolveDefaultBranchSha(REPO)).resolves.toBe(newSha);
  });

  it('materializes a per-Review worktree checked out at the given SHA', async () => {
    const origin = await makeOrigin();
    const firstSha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });
    await manager.ensureCloned(REPO);

    // A new commit lands; the worktree must pin the *requested* SHA, not HEAD.
    const headSha = await origin.commit('second', 'feature.ts', 'export const x = 1;\n');
    await manager.fetch(REPO);

    const worktree = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha: headSha });

    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(join(worktree.path, 'feature.ts'))).toBe(true);
    const checkedOut = await git(worktree.path, 'rev-parse', 'HEAD');
    expect(checkedOut).toBe(headSha);
    // An earlier SHA's later file is absent at this checkout.
    expect(firstSha).not.toBe(headSha);
  });

  it('isolates worktrees for the same Repo at different SHAs', async () => {
    const origin = await makeOrigin();
    const firstSha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });
    await manager.ensureCloned(REPO);
    const secondSha = await origin.commit('second', 'feature.ts', 'export const x = 1;\n');
    await manager.fetch(REPO);

    const a = await manager.createWorktree(REPO, { reviewJobId: 'rj_a', sha: firstSha });
    const b = await manager.createWorktree(REPO, { reviewJobId: 'rj_b', sha: secondSha });

    expect(a.path).not.toBe(b.path);
    expect(await git(a.path, 'rev-parse', 'HEAD')).toBe(firstSha);
    expect(await git(b.path, 'rev-parse', 'HEAD')).toBe(secondSha);
    // The older worktree does not see the newer commit's file.
    expect(existsSync(join(a.path, 'feature.ts'))).toBe(false);
    expect(existsSync(join(b.path, 'feature.ts'))).toBe(true);
  });

  it('keeps distinct reserved roots while populating and releasing prepared copies', async () => {
    const origin = await makeOrigin();
    const sha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const manager = new CloneManager({
      baseDir: join(tmpRoot, 'repos'),
      cloneUrl: () => origin.url,
    });
    await manager.ensureCloned(REPO);
    const seed = await manager.createWorktree(REPO, { reviewJobId: 'reserved', sha });
    await installWorkspaceFixture(seed.path);
    const first = await manager.reserveAgentWorkspace(seed, 'logic');
    const second = await manager.reserveAgentWorkspace(seed, 'security');
    expect(first.path).not.toBe(second.path);
    expect(await readdir(second.path)).toEqual([]);
    await manager.populateAgentWorkspace(seed, first);
    await exec(process.execPath, ['probe.cjs', 'logic'], { cwd: first.path });
    await manager.releaseAgentWorkspace(first);
    expect((await lstat(first.path)).isDirectory()).toBe(true);
    expect(await readdir(first.path)).toEqual([]);
    await manager.populateAgentWorkspace(seed, second);
    await exec(process.execPath, ['probe.cjs', 'security'], { cwd: second.path });
    expect(JSON.parse(await readFile(join(second.path, 'dist/result.json'), 'utf8'))).toEqual({
      agent: 'security',
      shared: 'workspace dependency',
    });
    await manager.removeWorktree(first);
    await manager.removeWorktree(second);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });

  it('gives Agents private prepared installations with working workspace dependencies', async () => {
    const origin = await makeOrigin();
    const headSha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const manager = new CloneManager({
      baseDir: join(tmpRoot, 'repos'),
      cloneUrl: () => origin.url,
    });
    await manager.ensureCloned(REPO);
    const seed = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha: headSha });
    await installWorkspaceFixture(seed.path);

    const logic = await manager.materializeAgentWorkspace(seed, 'logic');
    const security = await manager.materializeAgentWorkspace(seed, 'security');
    await Promise.all([
      exec(process.execPath, ['probe.cjs', 'logic'], { cwd: logic.path }),
      exec(process.execPath, ['probe.cjs', 'security'], { cwd: security.path }),
    ]);

    expect(JSON.parse(await readFile(join(logic.path, 'dist/result.json'), 'utf8'))).toEqual({
      agent: 'logic',
      shared: 'workspace dependency',
    });
    expect(JSON.parse(await readFile(join(security.path, 'dist/result.json'), 'utf8'))).toEqual({
      agent: 'security',
      shared: 'workspace dependency',
    });
    expect(await readFile(join(logic.path, 'node_modules/private-helper/index.js'), 'utf8')).toBe(
      'module.exports = "logic";',
    );
    expect(
      await readFile(join(security.path, 'node_modules/private-helper/index.js'), 'utf8'),
    ).toBe('module.exports = "security";');
    expect(await readFile(join(seed.path, 'node_modules/private-helper/index.js'), 'utf8')).toBe(
      'module.exports = "prepared";',
    );
    expect(existsSync(join(seed.path, 'dist/result.json'))).toBe(false);
    expect(await git(logic.path, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(await git(security.path, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(await git(logic.path, 'diff', 'HEAD', '--', 'README.md')).toContain('+logic');
    expect(await git(security.path, 'diff', 'HEAD', '--', 'README.md')).toContain('+security');
    expect(await readFile(join(seed.path, 'README.md'), 'utf8')).toBe('# seed\n');
  });

  it('keeps internal absolute dependency links inside the private Agent workspace', async () => {
    const origin = await makeOrigin();
    const sha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const manager = new CloneManager({
      baseDir: join(tmpRoot, 'repos'),
      cloneUrl: () => origin.url,
    });
    await manager.ensureCloned(REPO);
    const seed = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha });
    await mkdir(join(seed.path, 'packages/shared'), { recursive: true });
    await writeFile(join(seed.path, 'packages/shared/output.txt'), 'prepared');
    await symlink(join(seed.path, 'packages/shared'), join(seed.path, 'absolute-dependency'));

    const workspace = await manager.materializeAgentWorkspace(seed, 'logic');
    await writeFile(join(workspace.path, 'absolute-dependency/output.txt'), 'private');

    expect(await readFile(join(seed.path, 'packages/shared/output.txt'), 'utf8')).toBe('prepared');
    expect(await readFile(join(workspace.path, 'packages/shared/output.txt'), 'utf8')).toBe(
      'private',
    );
    expect((await lstat(join(workspace.path, 'absolute-dependency'))).isSymbolicLink()).toBe(true);
  });

  it('preserves hostile and dangling links without copying their host targets', async () => {
    const origin = await makeOrigin();
    const sha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const manager = new CloneManager({
      baseDir: join(tmpRoot, 'repos'),
      cloneUrl: () => origin.url,
    });
    await manager.ensureCloned(REPO);
    const seed = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha });
    const hostDirectory = join(tmpRoot, 'private-host');
    await mkdir(hostDirectory);
    await writeFile(join(hostDirectory, 'credential'), 'never materialize');
    await symlink(hostDirectory, join(seed.path, 'host-link'));
    await symlink(join(hostDirectory, 'missing'), join(seed.path, 'dangling-link'));

    const workspace = await manager.materializeAgentWorkspace(seed, 'logic');

    expect((await lstat(join(workspace.path, 'host-link'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(workspace.path, 'host-link'))).toBe(hostDirectory);
    expect(await readlink(join(workspace.path, 'dangling-link'))).toBe(
      join(hostDirectory, 'missing'),
    );
  });

  it('removes private Agent workspaces without deleting their prepared seed', async () => {
    const origin = await makeOrigin();
    const sha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const manager = new CloneManager({
      baseDir: join(tmpRoot, 'repos'),
      cloneUrl: () => origin.url,
    });
    await manager.ensureCloned(REPO);
    const seed = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha });
    const workspace = await manager.materializeAgentWorkspace(seed, 'logic');

    await manager.removeWorktree(workspace);
    await manager.removeWorktree(workspace);

    expect(existsSync(workspace.path)).toBe(false);
    expect(await git(seed.path, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('cleans up a partially materialized Agent workspace after a copy failure', async () => {
    const origin = await makeOrigin();
    const sha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });
    await manager.ensureCloned(REPO);
    const seed = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha });
    await exec('mkfifo', [join(seed.path, 'unsupported-pipe')]);

    await expect(manager.materializeAgentWorkspace(seed, 'logic')).rejects.toThrow();

    expect(
      await readdir(join(baseDir, '.agent-workspaces', REPO.owner, REPO.name, 'rj_1')),
    ).toEqual([]);
    expect(await git(seed.path, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('does not materialize a queued Agent after the Review is canceled', async () => {
    const origin = await makeOrigin();
    const sha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const controller = new AbortController();
    const manager = new CloneManager({
      baseDir: join(tmpRoot, 'repos'),
      cloneUrl: () => origin.url,
      signal: controller.signal,
    });
    await manager.ensureCloned(REPO);
    const seed = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha });
    controller.abort(new Error('Review canceled'));

    await expect(manager.materializeAgentWorkspace(seed, 'logic')).rejects.toThrow(
      'Review canceled',
    );
    expect(await git(seed.path, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('removes a worktree when the Review ends', async () => {
    const origin = await makeOrigin();
    const headSha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });
    const repoPath = await manager.ensureCloned(REPO);

    const worktree = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha: headSha });
    expect(existsSync(worktree.path)).toBe(true);

    await manager.removeWorktree(worktree);

    expect(existsSync(worktree.path)).toBe(false);
    // git no longer tracks the removed worktree.
    const list = await git(repoPath, 'worktree', 'list');
    expect(list).not.toContain(worktree.path);
  });

  it('removeWorktree is idempotent (a second removal is a no-op)', async () => {
    const origin = await makeOrigin();
    const headSha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });
    await manager.ensureCloned(REPO);

    const worktree = await manager.createWorktree(REPO, { reviewJobId: 'rj_1', sha: headSha });
    await manager.removeWorktree(worktree);
    await expect(manager.removeWorktree(worktree)).resolves.toBeUndefined();
  });

  it('createWorktree fetches the SHA if it is not yet present locally', async () => {
    const origin = await makeOrigin();
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });
    await manager.ensureCloned(REPO);

    // Commit AFTER the clone and DO NOT call fetch() — createWorktree must fetch.
    const headSha = await origin.commit('post-clone', 'late.ts', 'export const y = 2;\n');

    const worktree = await manager.createWorktree(REPO, { reviewJobId: 'rj_late', sha: headSha });

    expect(await git(worktree.path, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(await readFile(join(worktree.path, 'late.ts'), 'utf8')).toContain('export const y = 2;');
  });

  it('throws a clear error when cloning an unreachable origin', async () => {
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({
      baseDir,
      cloneUrl: () => join(tmpRoot, 'does-not-exist.git'),
    });

    await expect(manager.ensureCloned(REPO)).rejects.toThrow(/clone/i);
  });

  it('redacts clone URL credentials from git failure messages', async () => {
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({
      baseDir,
      cloneUrl: () => 'https://x-access-token:super-secret-token@127.0.0.1:1/tony-co/sandy.git',
    });

    let message = '';
    try {
      await manager.ensureCloned(REPO);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('git clone');
    expect(message).toContain('redacted');
    expect(message).not.toContain('super-secret-token');
  });

  it('re-creates a worktree at a path left behind by a crashed Review', async () => {
    const origin = await makeOrigin();
    const firstSha = await git(join(tmpRoot, 'origin.git'), 'rev-parse', 'HEAD');
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });
    await manager.ensureCloned(REPO);
    const secondSha = await origin.commit('second', 'feature.ts', 'export const x = 1;\n');
    await manager.fetch(REPO);

    // First materialization, then a re-run for the SAME reviewJobId WITHOUT
    // removeWorktree (simulating a crash mid-Review): the leftover dir is still
    // present and registered. createWorktree must reconcile and reuse the path,
    // re-pinned to the new SHA, rather than failing on the leftover.
    const first = await manager.createWorktree(REPO, { reviewJobId: 'rj_crash', sha: firstSha });
    expect(existsSync(first.path)).toBe(true);

    const second = await manager.createWorktree(REPO, { reviewJobId: 'rj_crash', sha: secondSha });
    expect(second.path).toBe(first.path);
    expect(await git(second.path, 'rev-parse', 'HEAD')).toBe(secondSha);
    expect(existsSync(join(second.path, 'feature.ts'))).toBe(true);
  });

  it('re-clones when an interrupted clone left a broken directory', async () => {
    const origin = await makeOrigin();
    const baseDir = join(tmpRoot, 'repos');
    const manager = new CloneManager({ baseDir, cloneUrl: () => origin.url });

    // Simulate an interrupted first clone: a directory with a bogus `.git` that
    // git does not recognize as a work tree.
    const dest = manager.repoPath(REPO);
    await mkdir(join(dest, '.git'), { recursive: true });
    await writeFile(join(dest, '.git', 'HEAD'), 'garbage\n');

    const repoPath = await manager.ensureCloned(REPO);

    // The broken dir was replaced by a real clone, so later operations work.
    expect(repoPath).toBe(dest);
    expect(existsSync(join(repoPath, 'README.md'))).toBe(true);
    expect(await git(repoPath, 'rev-parse', '--is-inside-work-tree')).toBe('true');
  });
});

async function installWorkspaceFixture(path: string): Promise<void> {
  await mkdir(join(path, 'packages/shared'), { recursive: true });
  await mkdir(join(path, 'vendor/private-helper'), { recursive: true });
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: {
        '@fixture/shared': 'workspace:*',
        'private-helper': 'file:vendor/private-helper',
      },
    }),
  );
  await writeFile(join(path, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(
    join(path, 'packages/shared/package.json'),
    JSON.stringify({ name: '@fixture/shared', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(
    join(path, 'packages/shared/index.js'),
    'module.exports = "workspace dependency";',
  );
  await writeFile(
    join(path, 'vendor/private-helper/package.json'),
    JSON.stringify({ name: 'private-helper', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(join(path, 'vendor/private-helper/index.js'), 'module.exports = "prepared";');
  await writeFile(
    join(path, 'probe.cjs'),
    `const fs = require('node:fs');
const agent = process.argv[2];
const shared = require('@fixture/shared');
fs.writeFileSync('README.md', agent + '\\n');
fs.writeFileSync(require.resolve('private-helper'), 'module.exports = ' + JSON.stringify(agent) + ';');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/result.json', JSON.stringify({ agent, shared }));
`,
  );
  await exec('pnpm', ['install', '--offline', '--ignore-scripts'], { cwd: path, timeout: 30_000 });
}
