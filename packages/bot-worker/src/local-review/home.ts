import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LocalReviewInputError } from './errors.js';

/** Where `sandy review` keeps its state; nothing here is shared with CI or `~/.codex`. */
export interface LocalReviewHome {
  root: string;
  /** Dedicated Codex login for local Reviews. */
  codexHome: string;
  /** Saved Review results. */
  reviews: string;
  /** Per-Review worktrees of the reviewed commits. */
  worktrees: string;
  /** Bare mirrors holding only the commits a Review needs. */
  mirrors: string;
  /** Clones of sibling Product Repos. */
  repos: string;
  lock: string;
}

export function localReviewHome(env: NodeJS.ProcessEnv, codexHome?: string): LocalReviewHome {
  const root = resolve(env.SANDY_CLI_HOME?.trim() || join(homedir(), '.sandy', 'cli'));
  return {
    root,
    codexHome: resolve(codexHome?.trim() || env.SANDY_CODEX_HOME?.trim() || join(root, 'codex')),
    reviews: join(root, 'reviews'),
    worktrees: join(root, 'worktrees'),
    mirrors: join(root, 'mirrors'),
    repos: join(root, 'repos'),
    lock: join(root, 'review.lock'),
  };
}

/**
 * Refuse state locations that would share or expose another login. The Codex
 * runner also writes tool caches beside CODEX_HOME, so its parent must be
 * dedicated too.
 */
export async function assertDedicatedHome(home: LocalReviewHome): Promise<void> {
  const user = await canonicalPath(homedir());
  const root = await canonicalPath(home.root);
  const codexHome = await canonicalPath(home.codexHome);
  if (isWithin(user, root)) {
    throw new LocalReviewInputError(
      'SANDY_CLI_HOME must be a dedicated directory, not your home directory or one of its parents',
    );
  }
  if (isWithin(codexHome, await canonicalPath(join(homedir(), '.codex')))) {
    throw new LocalReviewInputError(
      'sandy review needs its own Codex login; ~/.codex is never used or copied. Run `sandy login`.',
    );
  }
  const parent = dirname(codexHome);
  if (isWithin(user, codexHome) || isWithin(user, parent)) {
    throw new LocalReviewInputError(
      'The Codex home for sandy needs a dedicated parent directory; Sandy keeps tool caches beside it',
    );
  }
}

/** Create the state root and the Codex home with owner-only access. */
export async function ensureHomeDirectories(home: LocalReviewHome): Promise<void> {
  for (const path of [home.root, home.codexHome]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}

/** Login, status, and logout read `auth.json` only through Codex itself. */
export async function hasCodexLogin(home: LocalReviewHome): Promise<boolean> {
  return await pathExists(join(home.codexHome, 'auth.json'));
}

/**
 * Credential stores Agents never need. Reviewer tools run with a replacement
 * HOME, so hiding these breaks nothing a Review uses. The runner already
 * denies `~/.codex`, `~/.ssh`, `~/.config/gh`, and its own Codex home.
 */
const HOME_CREDENTIAL_PATHS = [
  '.config',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.gnupg',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.password-store',
  '.vault-token',
  '.claude',
  '.claude.json',
  '.terraform.d',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.gem/credentials',
  '.m2/settings.xml',
  '.gradle/gradle.properties',
  '.local/share/keyrings',
  '.gitconfig',
  '.pgpass',
  '.my.cnf',
  '.s3cfg',
  '.boto',
  '.oci',
  '.fly',
  '.wrangler',
  '.ngrok2',
  '.convex',
  '.vercel',
  '.zsh_history',
  '.bash_history',
  '.local/share/fish/fish_history',
  '.node_repl_history',
  '.python_history',
  '.psql_history',
  '.mysql_history',
  '.sqlite_history',
];

export interface ProtectedPathInput {
  home: LocalReviewHome;
  /** The developer's checkouts: uncommitted work and local `.env` files stay hidden. */
  checkoutRoots: readonly string[];
  sandyRoot: string;
  configPath?: string;
  /** The developer's own additions, such as another tool's login. */
  hiddenPaths?: readonly string[];
}

/** Absolute paths from SANDY_REVIEW_HIDDEN_PATHS, separated like PATH. */
export function hiddenPathsFrom(env: NodeJS.ProcessEnv): string[] {
  const paths = (env.SANDY_REVIEW_HIDDEN_PATHS ?? '')
    .split(delimiter)
    .map((path) => path.trim())
    .filter((path) => path !== '');
  const relativePath = paths.find((path) => !isAbsolute(path));
  if (relativePath !== undefined) {
    throw new LocalReviewInputError(
      `SANDY_REVIEW_HIDDEN_PATHS takes absolute paths; got ${relativePath}`,
    );
  }
  return paths;
}

/** Existing host paths the Agent sandbox must not read. */
export async function localProtectedPaths(input: ProtectedPathInput): Promise<string[]> {
  const user = homedir();
  const candidates = [
    ...input.checkoutRoots,
    input.home.reviews,
    join(input.sandyRoot, '.config'),
    ...(input.configPath === undefined ? [] : [input.configPath]),
    // HOME is remapped for tools; Library holds keychains, browser profiles, and app tokens.
    ...(process.platform === 'darwin' ? [join(user, 'Library')] : []),
    ...HOME_CREDENTIAL_PATHS.map((path) => join(user, path)),
    ...(input.hiddenPaths ?? []),
    // Other Sandy logins and clones.
    join(user, '.sandy'),
  ];
  // Never hide the Review's own workspace or the runner's tool caches.
  const visible = [
    await canonicalPath(input.home.root),
    dirname(await canonicalPath(input.home.codexHome)),
  ];
  const paths = new Set<string>();
  for (const candidate of candidates) {
    for (const path of await hiddenAround(await canonicalPath(candidate), visible)) {
      if (await pathExists(path)) paths.add(path);
    }
  }
  return [...paths];
}

/** `path` itself, or everything else inside it when it holds a visible directory. */
async function hiddenAround(
  path: string,
  visible: readonly string[],
  descended = new Set<string>(),
): Promise<string[]> {
  if (!visible.some((keep) => isWithin(keep, path))) return [path];
  // A symlinked entry may lead back to a directory already split.
  if (visible.includes(path) || descended.has(path)) return [];
  descended.add(path);
  const hidden: string[] = [];
  for (const entry of await readdir(path).catch(() => [])) {
    const child = await canonicalPath(join(path, entry));
    hidden.push(...(await hiddenAround(child, visible, descended)));
  }
  return hidden;
}

/**
 * Hold one Review at a time per CLI home. Concurrent Codex processes would race
 * on refreshing the one login, and Reviews share mirrors and sibling clones.
 */
export async function acquireReviewLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return async () => {
        const owner = await readFile(path, 'utf8').catch(() => '');
        if (owner.trim() === String(process.pid)) await rm(path, { force: true });
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      const raw = (await readFile(path, 'utf8').catch(() => '')).trim();
      const pid = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      const fresh = await stat(path).then(
        (entry) => Date.now() - entry.mtimeMs < 10_000,
        () => false,
      );
      if ((Number.isSafeInteger(pid) && processAlive(pid)) || (Number.isNaN(pid) && fresh)) {
        throw new LocalReviewInputError(
          `Another sandy review is running${Number.isNaN(pid) ? '' : ` (pid ${pid})`}; wait for it to finish`,
        );
      }
      await rm(path, { force: true });
    }
  }
  throw new LocalReviewInputError('Could not acquire the sandy review lock');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

/** Remove a tree whose reviewed tooling may have dropped owner write access. */
export async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!isErrno(error, 'EACCES') && !isErrno(error, 'EPERM')) throw error;
    await restoreDirectoryAccess(path);
    await rm(path, { recursive: true, force: true });
  }
}

/** Symlinks and files never receive chmod. */
async function restoreDirectoryAccess(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (entry === null || !entry.isDirectory()) return;
  await chmod(path, entry.mode | 0o700);
  for (const name of await readdir(path)) await restoreDirectoryAccess(join(path, name));
}

/** Resolve symlinks through the deepest existing ancestor of `path`. */
export async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function isWithin(path: string, parent: string): boolean {
  const relation = relative(parent, path);
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

export async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
