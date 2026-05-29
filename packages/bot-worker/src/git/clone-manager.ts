import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
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
  cloneUrl: (repo: RepoIdentity) => string;
}

export class CloneManager {
  readonly #baseDir: string;
  readonly #cloneUrl: (repo: RepoIdentity) => string;

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
   * calls (idempotent). The clone is created fresh under the Repo's namespaced
   * path; a present `.git` directory is treated as an existing clone.
   */
  async ensureCloned(repo: RepoIdentity): Promise<string> {
    const dest = this.repoPath(repo);
    if (await isGitRepo(dest)) {
      return dest;
    }
    await mkdir(join(this.#baseDir, repo.owner), { recursive: true });
    await this.#git(this.#baseDir, [
      'clone',
      '--branch',
      repo.defaultBranch,
      this.#cloneUrl(repo),
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
    // `--detach` checks out the SHA without creating a branch; `--force` lets a
    // re-run reuse a path left behind by a crash mid-Review.
    await this.#git(repoDir, ['worktree', 'add', '--detach', '--force', path, request.sha]);

    return { repo, path, sha: request.sha, reviewJobId: request.reviewJobId };
  }

  /**
   * Remove a Review's worktree when the Review ends. Idempotent: a second removal
   * (or removal of a never-created worktree) is a no-op, so teardown can run on
   * both the success and failure paths without guarding.
   */
  async removeWorktree(worktree: Worktree): Promise<void> {
    const repoDir = this.repoPath(worktree.repo);
    if (await pathExists(worktree.path)) {
      // `--force` removes the worktree even if it has untracked/modified files,
      // which a Review's tooling may have left behind.
      await this.#git(repoDir, ['worktree', 'remove', '--force', worktree.path]);
    }
    // Drop any administrative leftovers (e.g. a stale entry whose dir is already
    // gone), keeping `git worktree list` clean for the next Review.
    await this.#git(repoDir, ['worktree', 'prune']);
  }

  /** Absolute path a Review's worktree is materialized at. */
  worktreePath(repo: RepoIdentity, reviewJobId: string): string {
    return join(this.#baseDir, '.worktrees', repo.owner, repo.name, reviewJobId);
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

/** Whether `dir` is the working tree of a git clone (has a `.git` entry). */
async function isGitRepo(dir: string): Promise<boolean> {
  return pathExists(join(dir, '.git'));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
