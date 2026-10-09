import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, posix, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

interface GitEntry {
  mode: string;
  oid: string;
}

export class RepoFileReadError extends Error {}

/** Host-side context comes from Git objects, never from a mutable PR checkout. */
export interface RepoFileSnapshot {
  sha: string;
  listFiles(): string[];
  readText(relativePath: string): Promise<string | null>;
}

export async function createRepoFileSnapshot(
  root: string,
  revision = 'HEAD',
): Promise<RepoFileSnapshot> {
  if (revision !== 'HEAD' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) {
    throw new Error('Repository context requires a commit SHA');
  }
  // Resolve trusted Git metadata before any reviewed install/test process.
  // Object commands do not run hooks, textconv, smudge filters, or checkout files.
  const rootPath = await realpath(resolve(root));
  const repositoryRoot = (await runGit(['-C', rootPath, 'rev-parse', '--show-toplevel'])).trim();
  if ((await realpath(repositoryRoot)) !== rootPath) {
    throw new Error('Repository context requires the root of a Git checkout');
  }
  const gitDir = (await runGit(['-C', rootPath, 'rev-parse', '--absolute-git-dir'])).trim();
  const git = (...args: string[]) => runGit([`--git-dir=${gitDir}`, ...args]);
  const sha = (await git('rev-parse', '--verify', `${revision}^{commit}`)).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new Error('Git returned an invalid commit SHA');
  }
  const tree = await git('ls-tree', '-r', '-t', '-z', '--full-tree', sha);
  const entries = new Map<string, GitEntry>();
  for (const record of tree.split('\0')) {
    if (record.length === 0) continue;
    const match = record.match(/^(\d{6}) (?:blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/);
    if (match === null) throw new Error('Git returned an invalid tree entry');
    const [, mode, oid, path] = match;
    if (mode === undefined || oid === undefined || path === undefined) {
      throw new Error('Git returned an incomplete tree entry');
    }
    entries.set(path, { mode, oid });
  }
  const blobs = new Map<string, Promise<string>>();
  const readBlob = (oid: string): Promise<string> => {
    let blob = blobs.get(oid);
    if (blob === undefined) {
      blob = git('cat-file', 'blob', oid);
      blobs.set(oid, blob);
    }
    return blob;
  };
  return {
    sha,
    listFiles: () =>
      [...entries]
        .filter(
          ([path, entry]) =>
            isRegularFile(entry) &&
            !path
              .split('/')
              .slice(0, -1)
              .some((dir) => SKIP_DIRS.has(dir)),
        )
        .map(([path]) => path)
        .sort(),
    readText: async (relativePath) => {
      let path = normalizeRepoPath(relativePath);
      if (path === null) return null;
      // Resolve tracked links only within this immutable tree. No host symlink
      // is followed, even if a script replaces a file or an ancestor directory.
      for (let links = 0; links < 40; links += 1) {
        const parts = path.split('/');
        let followedLink = false;
        for (let index = 0; index < parts.length; index += 1) {
          const prefix = parts.slice(0, index + 1).join('/');
          const entry = entries.get(prefix);
          if (entry?.mode !== '120000') continue;
          const target = await readBlob(entry.oid);
          if (posix.isAbsolute(target)) {
            throw new RepoFileReadError(
              'Repository symlinks must not resolve outside the repository',
            );
          }
          path = normalizeRepoPath(
            posix.join(posix.dirname(prefix), target, ...parts.slice(index + 1)),
          );
          if (path === null) {
            throw new RepoFileReadError(
              'Repository symlinks must not resolve outside the repository',
            );
          }
          followedLink = true;
          break;
        }
        if (followedLink) continue;
        const entry = entries.get(path);
        if (entry === undefined) return null;
        if (!isRegularFile(entry)) {
          throw new RepoFileReadError('Repository entries must be a regular file');
        }
        return await readBlob(entry.oid);
      }
      throw new RepoFileReadError('Repository symlink resolution exceeded its limit');
    },
  };
}

export async function readRepoText(root: string, relativePath: string): Promise<string | null> {
  return await (await createRepoFileSnapshot(root)).readText(relativePath);
}

export async function repoFileExists(root: string, relativePath: string): Promise<boolean> {
  return (await readRepoText(root, relativePath)) !== null;
}

export async function listRepoFiles(root: string): Promise<string[]> {
  return (await createRepoFileSnapshot(root)).listFiles();
}

export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function parentDir(path: string): string {
  const dir = dirname(path);
  return dir === '.' ? '' : toPosix(dir);
}

function normalizeRepoPath(path: string): string | null {
  if (posix.isAbsolute(path) || path.includes('\0')) return null;
  const normalized = posix.normalize(path);
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}

function isRegularFile(entry: GitEntry): boolean {
  return entry.mode === '100644' || entry.mode === '100755';
}

async function runGit(args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const { stdout } = await execFileAsync(
    'git',
    [
      '--no-pager',
      '--no-optional-locks',
      '--literal-pathspecs',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.allow=never',
      ...args,
    ],
    { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout;
}
