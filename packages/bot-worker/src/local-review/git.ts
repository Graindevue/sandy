import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalReviewInputError } from './errors.js';

const exec = promisify(execFile);

export interface GitResult {
  stdout: string;
  exitCode: number;
}

/**
 * Run git in the developer's checkout. Optional index locks stay off so a
 * Review never contends with the developer's own Git work, and git never
 * prompts because the review may run unattended.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: {
    allowExitCodes?: readonly number[];
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  } = {},
): Promise<GitResult> {
  try {
    const { stdout } = await exec('git', [...args], {
      cwd,
      env: { ...process.env, ...options.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof failure.code === 'number' && options.allowExitCodes?.includes(failure.code)) {
      return { stdout: String(failure.stdout ?? ''), exitCode: failure.code };
    }
    const detail =
      String(failure.stderr ?? '').trim() ||
      (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args[0] ?? ''} failed in ${cwd}: ${detail}`);
  }
}

export interface LocalCheckout {
  /** Top-level directory of the developer's working tree. */
  root: string;
  headSha: string;
  /** Checked-out branch, or `null` on a detached HEAD. */
  branch: string | null;
  /** Fetch URL of `origin`, when the checkout has one. */
  originUrl: string | null;
}

export async function readLocalCheckout(cwd: string): Promise<LocalCheckout> {
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], { allowExitCodes: [128] });
  if (top.exitCode !== 0) {
    throw new LocalReviewInputError('Run sandy review inside a Git working tree');
  }
  const root = top.stdout.trim();
  const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    allowExitCodes: [1, 128],
  });
  if (head.exitCode !== 0) {
    throw new LocalReviewInputError('HEAD has no commit to review');
  }
  const branch = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowExitCodes: [1, 128],
  });
  const origin = await runGit(root, ['remote', 'get-url', 'origin'], {
    allowExitCodes: [2, 128],
  });
  return {
    root,
    headSha: head.stdout.trim(),
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    originUrl: origin.exitCode === 0 && origin.stdout.trim() !== '' ? origin.stdout.trim() : null,
  };
}

export interface ReviewBase {
  /** How the base reads in output and the prompt, for example `origin/main`. */
  label: string;
  /** Full ref name when the base is a branch or tag, for example `refs/remotes/origin/main`. */
  fullRef: string | null;
  /** Base tip the diff is computed against, with merge-base (`...`) semantics. */
  sha: string;
  mergeBase: string;
}

/**
 * Resolve the base the way a pull request would see it: the remote-tracking
 * branch is preferred over a possibly stale local branch of the same name.
 * Nothing is fetched; the base is pinned to its current local SHA.
 */
export async function resolveReviewBase(
  root: string,
  headSha: string,
  requested?: string,
): Promise<ReviewBase> {
  if (requested !== undefined && !/^[^-\s][^\s]*$/.test(requested)) {
    throw new LocalReviewInputError('--branch must name a branch, tag, or commit');
  }
  const candidates =
    requested === undefined
      ? await defaultBaseCandidates(root)
      : requestedBaseCandidates(requested);
  for (const ref of candidates) {
    const resolved = await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      allowExitCodes: [1, 128],
    });
    if (resolved.exitCode !== 0) {
      continue;
    }
    const fullRef = await symbolicFullName(root, ref);
    const label = baseLabel(fullRef ?? ref);
    const sha = resolved.stdout.trim();
    const mergeBase = await runGit(root, ['merge-base', sha, headSha], { allowExitCodes: [1] });
    if (mergeBase.exitCode !== 0) {
      throw new LocalReviewInputError(`${label} shares no history with HEAD`);
    }
    return { label, fullRef, sha, mergeBase: mergeBase.stdout.trim() };
  }
  throw new LocalReviewInputError(
    requested === undefined
      ? 'No base found at origin/HEAD, origin/main, or origin/master; pass --branch <base>'
      : `Base ${requested} does not resolve to a commit`,
  );
}

function requestedBaseCandidates(requested: string): string[] {
  if (requested.startsWith('refs/')) {
    return [requested];
  }
  // Revision expressions such as `HEAD~3` or a SHA resolve only as given.
  const branchLike =
    /^[A-Za-z0-9._/-]+$/.test(requested) && !requested.includes('..') && requested !== 'HEAD';
  if (!branchLike) {
    return [requested];
  }
  const remote = requested.startsWith('origin/')
    ? `refs/remotes/${requested}`
    : `refs/remotes/origin/${requested}`;
  return [remote, requested];
}

async function defaultBaseCandidates(root: string): Promise<string[]> {
  const head = await runGit(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    allowExitCodes: [1, 128],
  });
  const fallbacks = ['refs/remotes/origin/main', 'refs/remotes/origin/master'];
  return head.exitCode === 0 ? [...new Set([head.stdout.trim(), ...fallbacks])] : fallbacks;
}

/** `@{upstream}` and other ref shorthands resolve to the ref they name; SHAs have none. */
async function symbolicFullName(root: string, ref: string): Promise<string | null> {
  if (ref.startsWith('refs/')) return ref;
  const named = await runGit(root, ['rev-parse', '--symbolic-full-name', ref], {
    allowExitCodes: [128],
  });
  const fullRef = named.stdout.trim();
  return named.exitCode === 0 && fullRef.startsWith('refs/') && !fullRef.includes('\n')
    ? fullRef
    : null;
}

function baseLabel(ref: string): string {
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/tags/')) return ref.slice('refs/tags/'.length);
  return ref;
}

/** Shared Git directory of the checkout; a linked worktree reports its main repository's. */
export async function gitCommonDir(root: string): Promise<string> {
  const { stdout } = await runGit(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return stdout.trim();
}

/** Every working tree of the checkout's repository, including the main one. */
export async function checkoutWorktrees(root: string): Promise<string[]> {
  const { stdout } = await runGit(root, ['worktree', 'list', '--porcelain', '-z']);
  return stdout
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
}

/** Branch `origin/HEAD` points at, when the clone recorded one. */
export async function originDefaultBranch(root: string): Promise<string | null> {
  const head = await runGit(
    root,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    {
      allowExitCodes: [1, 128],
    },
  );
  const branch = head.stdout.trim();
  return head.exitCode === 0 && branch.startsWith('origin/')
    ? branch.slice('origin/'.length)
    : null;
}

export async function hasCommittedChanges(
  root: string,
  baseSha: string,
  headSha: string,
): Promise<boolean> {
  const diff = await runGit(
    root,
    ['diff', '--quiet', '--no-ext-diff', '--no-textconv', `${baseSha}...${headSha}`, '--'],
    { allowExitCodes: [1] },
  );
  return diff.exitCode === 1;
}

/** Working-tree entries a Review cannot see because only commits are reviewed. */
export async function uncommittedEntryCount(root: string): Promise<number> {
  const status = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const entries = status.stdout.split('\0');
  let count = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined || entry === '') continue;
    count++;
    // Renames and copies carry their source path as a second record.
    if (entry.startsWith('R') || entry.startsWith('C')) index++;
  }
  return count;
}

export interface RemoteRepository {
  owner: string;
  name: string;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_REMOTE = /^((?:[^@/:]+@)?[^/:]+:)(.+)$/;

/** Owner and name from the last two path segments of a URL, scp-like, or local remote. */
export function parseRemoteRepository(remote: string): RemoteRepository | null {
  const path = remotePath(remote.trim());
  if (path === null) return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  const owner = segments.at(-2);
  const name = segments.at(-1)?.replace(/\.git$/, '');
  if (owner === undefined || name === undefined || !validSegment(owner) || !validSegment(name)) {
    return null;
  }
  return { owner, name };
}

/**
 * Clone URL for a sibling Repo on the same host and transport as the
 * reviewed checkout's origin, so the developer's own Git credentials apply.
 */
export function siblingCloneUrl(originUrl: string | null, repo: RemoteRepository): string {
  const fallback = `https://github.com/${repo.owner}/${repo.name}.git`;
  if (originUrl === null) return fallback;
  const remote = originUrl.trim();
  if (URL_SCHEME.test(remote)) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return fallback;
    }
    const path = siblingPath(url.pathname, repo);
    if (path === null) return fallback;
    url.pathname = path;
    // Never forward an embedded token; SSH keeps its login user.
    if (url.protocol !== 'ssh:') url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  const scp = SCP_REMOTE.exec(remote);
  const path = siblingPath(scp?.[2] ?? remote, repo);
  return path === null ? fallback : `${scp?.[1] ?? ''}${path}`;
}

/** The remote path with its last two segments naming the sibling, in the origin's `.git` style. */
function siblingPath(path: string, repo: RemoteRepository): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return null;
  const suffix = segments.at(-1)?.endsWith('.git') === true ? '.git' : '';
  const sibling = [...segments.slice(0, -2), repo.owner, `${repo.name}${suffix}`].join('/');
  return path.startsWith('/') ? `/${sibling}` : sibling;
}

function remotePath(remote: string): string | null {
  if (URL_SCHEME.test(remote)) {
    try {
      return decodeURIComponent(new URL(remote).pathname);
    } catch {
      return null;
    }
  }
  return SCP_REMOTE.exec(remote)?.[2] ?? remote;
}

function validSegment(segment: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..';
}
