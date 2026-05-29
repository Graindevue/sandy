import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Owns each registered Repo's on-disk clone and the per-Review `git worktree`s
 * checked out from it. A Repo is cloned on first observation and fetched on
 * later pushes; a Review gets an isolated worktree pinned to the PR head SHA,
 * removed when the Review ends (CONTEXT.md "Repo", "Review").
 *
 * All git work shells out to the `git` binary via `execFile` (never a shell), so
 * Repo names and SHAs are passed as argv and cannot be interpreted as flags or
 * shell syntax.
 */

/** The minimal Repo identity the manager needs: enough to clone and namespace. */
export interface RepoIdentity {
  owner: string;
  name: string;
  /** Branch the clone tracks, e.g. `"main"`. */
  defaultBranch: string;
}

/** A materialized per-Review worktree. */
export interface Worktree {
  /** The Repo this worktree belongs to. */
  repo: RepoIdentity;
  /** Absolute path to the worktree's working directory. */
  path: string;
  /** The exact commit SHA checked out. */
  sha: string;
  /** The ReviewJob this worktree was created for. */
  reviewJobId: string;
}

/** What a worktree is requested for: a specific Review at a specific SHA. */
export interface WorktreeRequest {
  reviewJobId: string;
  /** Exact commit SHA to check out (the PR head). */
  sha: string;
}

export interface CloneManagerOptions {
  /**
   * Base directory holding all clones and worktrees. Must live OUTSIDE the Sandy
   * repo and be gitignored (the operator points this at host-local scratch
   * space, e.g. `~/.sandy/repos`).
   */
  baseDir: string;
  /**
   * Resolve the git URL to clone a Repo from. Injected so production can build an
   * authenticated GitHub App URL (issue #6) while tests point at a local origin.
   */
  cloneUrl: (repo: RepoIdentity) => string | Promise<string>;
}

export class CloneManager {
  readonly #baseDir: string;
  readonly #cloneUrl: (repo: RepoIdentity) => string | Promise<string>;

  constructor(options: CloneManagerOptions) {
    this.#baseDir = options.baseDir;
    this.#cloneUrl = options.cloneUrl;
  }

  /** Absolute path to a Repo's clone: `<baseDir>/<owner>/<name>`. */
  repoPath(repo: RepoIdentity): string {
    return join(this.#baseDir, repo.owner, repo.name);
  }

  /**
   * Clone the Repo on first observation; return its existing clone path on later
   * calls (idempotent). A healthy existing clone is reused; a leftover directory
   * that git doesn't recognize as a work tree (e.g. an interrupted first clone
   * that left a partial `.git` behind) is removed and re-cloned, so a broken
   * clone self-heals instead of wedging every later fetch/worktree.
   */
  async ensureCloned(repo: RepoIdentity): Promise<string> {
    const dest = this.repoPath(repo);
    if (await this.#isClonedRepo(dest)) {
      return dest;
    }
    // Clear any leftover (a partial clone) so `git clone` doesn't fail on a
    // non-empty target; `rm` with `force` is a no-op when the path is absent.
    await rm(dest, { recursive: true, force: true });
    await mkdir(join(this.#baseDir, repo.owner), { recursive: true });
    await this.#git(this.#baseDir, [
      'clone',
      '--branch',
      repo.defaultBranch,
      await this.#cloneUrl(repo),
      dest,
    ]);
    return dest;
  }

  /**
   * Fetch updates for an already-cloned Repo (called on a push). Fetches all
   * branches and prunes deleted refs so the local clone tracks the remote.
   */
  async fetch(repo: RepoIdentity): Promise<void> {
    const dest = this.repoPath(repo);
    await this.#git(dest, ['fetch', '--prune', 'origin']);
  }

  /**
   * Materialize an isolated worktree for one Review, checked out at the exact
   * `sha`. Fetches first so a SHA pushed since the last `fetch` is present, then
   * adds a detached worktree pinned to that commit. Worktrees live under
   * `<baseDir>/.worktrees/<owner>/<name>/<reviewJobId>`, outside the clone's own
   * working tree so they never appear as untracked files in it.
   */
  async createWorktree(repo: RepoIdentity, request: WorktreeRequest): Promise<Worktree> {
    const repoDir = this.repoPath(repo);
    // Pull the requested commit in case it landed after the last fetch (e.g. a
    // mention arrives before the push webhook); a no-op if already present.
    await this.#git(repoDir, ['fetch', '--prune', 'origin']);

    const path = this.worktreePath(repo, request.reviewJobId);
    await mkdir(join(this.#baseDir, '.worktrees', repo.owner, repo.name), { recursive: true });
    // Reconcile any leftover at this path before adding: a Review that crashed
    // after `worktree add` leaves the directory present AND registered, and
    // `git worktree add` refuses an existing path even with `--force` (that only
    // rescues a missing-but-registered path). Clearing first lets a re-run for
    // the same Review reuse the path deterministically.
    await this.#clearWorktree(repoDir, path);
    // `--detach` checks out the SHA without creating a branch.
    await this.#git(repoDir, ['worktree', 'add', '--detach', path, request.sha]);

    return { repo, path, sha: request.sha, reviewJobId: request.reviewJobId };
  }

  /**
   * Remove a Review's worktree when the Review ends. Idempotent: a second removal
   * (or removal of a never-created worktree) is a no-op, so teardown can run on
   * both the success and failure paths without guarding.
   */
  async removeWorktree(worktree: Worktree): Promise<void> {
    await this.#clearWorktree(this.repoPath(worktree.repo), worktree.path);
  }

  /**
   * Remove any worktree registered or left on disk at `path`, then prune stale
   * administrative entries, so a fresh `worktree add` there can't fail on
   * leftovers. Idempotent — shared by createWorktree (pre-add reconcile) and
   * removeWorktree (teardown), so teardown is safe on both the success and
   * failure paths and a never-created worktree is a no-op.
   */
  async #clearWorktree(repoDir: string, path: string): Promise<void> {
    if (await pathExists(path)) {
      // `--force` removes the worktree even with untracked/modified files a
      // Review's tooling may have left behind.
      await this.#git(repoDir, ['worktree', 'remove', '--force', path]);
    }
    // Drop administrative leftovers (e.g. a stale entry whose dir is already
    // gone): `worktree add` refuses a path that is still registered.
    await this.#git(repoDir, ['worktree', 'prune']);
  }

  /** Absolute path a Review's worktree is materialized at. */
  worktreePath(repo: RepoIdentity, reviewJobId: string): string {
    return join(this.#baseDir, '.worktrees', repo.owner, repo.name, reviewJobId);
  }

  /**
   * Whether `dest` is a usable clone. A bare `.git` check isn't enough: an
   * interrupted first clone (process killed, disk full) can leave a partial
   * `.git` behind, which must NOT be treated as healthy or every later
   * fetch/worktree fails forever. Confirm git itself accepts it as a work tree.
   */
  async #isClonedRepo(dest: string): Promise<boolean> {
    if (!(await pathExists(join(dest, '.git')))) {
      return false;
    }
    try {
      await exec('git', ['-C', dest, 'rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run `git` with the given args in `cwd`. Wraps failures with the command and
   * git's stderr so a clone/fetch/worktree error is actionable rather than a bare
   * non-zero exit.
   */
  async #git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await exec('git', args, { cwd });
      return stdout;
    } catch (error) {
      const stderr =
        typeof error === 'object' && error !== null && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';
      const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
      throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
