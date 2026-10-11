import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { agentWorkspaceCapacity, type WorkspaceCapacity } from './workspace-capacity.js';

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
  signal?: AbortSignal;
  /**
   * `overlay` layers each Agent workspace over the read-only seed instead of
   * copying it. Falls back to copies when overlay mounts are unavailable.
   */
  agentWorkspaces?: AgentWorkspaceLayout;
  /** Privileged overlay operations; defaults to `sudo -n` mounts on Linux. */
  workspaceLayers?: WorkspaceLayers;
  log?: (message: string) => void;
}

export type AgentWorkspaceLayout = 'copy' | 'overlay';

/** An overlay mount: `target` shows `lower` with writes landing in `upper`. */
export interface WorkspaceLayer {
  lower: string;
  upper: string;
  work: string;
  target: string;
}

export interface WorkspaceLayers {
  mount(layer: WorkspaceLayer): Promise<void>;
  unmount(target: string): Promise<void>;
  /** Overlay work directories hold kernel-owned entries an unprivileged `rm` cannot delete. */
  remove(path: string): Promise<void>;
}

/** Kernel overlayfs through passwordless sudo, as on GitHub-hosted Linux runners. */
export const sudoWorkspaceLayers: WorkspaceLayers = {
  async mount({ lower, upper, work, target }) {
    await exec(
      'sudo',
      [
        '-n',
        'mount',
        '-t',
        'overlay',
        'overlay',
        '-o',
        `lowerdir=${lower},upperdir=${upper},workdir=${work}`,
        target,
      ],
      { timeout: 30_000 },
    );
  },
  async unmount(target) {
    await exec('sudo', ['-n', 'umount', target], { timeout: 30_000 });
  },
  async remove(path) {
    await exec('sudo', ['-n', 'rm', '-rf', '--', path], { timeout: 120_000 });
  },
};

interface SeedLink {
  /** Link path relative to the seed. */
  path: string;
  /** Absolute target rewritten relative to the seed. */
  target: string;
}

export class CloneManager {
  readonly #baseDir: string;
  readonly #cloneUrl: (repo: RepoIdentity) => string | Promise<string>;
  readonly #signal: AbortSignal | undefined;
  readonly #agentWorkspaces = new Set<string>();
  readonly #requestedLayout: AgentWorkspaceLayout;
  readonly #layers: WorkspaceLayers | undefined;
  readonly #log: ((message: string) => void) | undefined;
  #layout: Promise<AgentWorkspaceLayout> | undefined;
  /** Mounted Agent workspace -> its upper/work layer directory. */
  readonly #layerMounts = new Map<string, string>();
  readonly #seedLinks = new Map<string, Promise<SeedLink[]>>();

  constructor(options: CloneManagerOptions) {
    this.#baseDir = options.baseDir;
    this.#cloneUrl = options.cloneUrl;
    this.#signal = options.signal;
    this.#requestedLayout = options.agentWorkspaces ?? 'copy';
    this.#layers =
      options.workspaceLayers ?? (process.platform === 'linux' ? sudoWorkspaceLayers : undefined);
    this.#log = options.log;
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
    const cloneUrl = await this.#cloneUrl(repo);
    await this.#git(this.#baseDir, ['clone', '--branch', repo.defaultBranch, cloneUrl, dest]);
    await this.#git(dest, ['remote', 'set-url', 'origin', credentialFreeUrl(cloneUrl)]);
    return dest;
  }

  /**
   * Fetch updates for an already-cloned Repo (called on a push). Fetches all
   * branches and prunes deleted refs so the local clone tracks the remote.
   */
  async fetch(repo: RepoIdentity): Promise<void> {
    const cloneUrl = await this.#cloneUrl(repo);
    const repoDir = this.repoPath(repo);
    // Credentials are supplied to this command only. They never reach the
    // worktree's shared .git/config, which reviewed code and Agents can read.
    await this.#git(repoDir, ['remote', 'set-url', 'origin', credentialFreeUrl(cloneUrl)]);
    await this.#git(repoDir, [
      'fetch',
      '--no-write-fetch-head',
      '--prune',
      cloneUrl,
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
  }

  /**
   * Resolve the Repo's current default-branch HEAD after fetching origin. Used
   * by per-Review manifest builds so sibling Repo surfaces are pinned to the
   * exact SHA the manifest describes.
   */
  async resolveDefaultBranchSha(repo: RepoIdentity): Promise<string> {
    const dest = this.repoPath(repo);
    await this.fetch(repo);
    return (await this.#git(dest, ['rev-parse', `origin/${repo.defaultBranch}`])).trim();
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
    // mention arrives before the push webhook); a no-op if already present. Goes
    // through fetch() so origin's (expiring) App token is refreshed first.
    await this.fetch(repo);

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

  async checkAgentWorkspaceCapacity(
    seed: Worktree,
    workspaceCount: number,
  ): Promise<WorkspaceCapacity> {
    const parent = join(this.#baseDir, '.agent-workspaces');
    await mkdir(parent, { recursive: true });
    return agentWorkspaceCapacity(seed.path, parent, workspaceCount, this.#signal, {
      layered: (await this.#agentWorkspaceLayout()) === 'overlay',
    });
  }

  /** Reserve every distinct peer root before the runtime constructs deny rules. */
  async reserveAgentWorkspace(seed: Worktree, agentKey: string): Promise<Worktree> {
    this.#signal?.throwIfAborted();
    const parent = join(
      this.#baseDir,
      '.agent-workspaces',
      seed.repo.owner,
      seed.repo.name,
      seed.reviewJobId,
    );
    await mkdir(parent, { recursive: true });
    const key = createHash('sha256').update(agentKey).digest('hex').slice(0, 12);
    const path = await mkdtemp(join(parent, `${key}-`));
    this.#agentWorkspaces.add(path);
    return { ...seed, path };
  }

  /**
   * Layer or copy the quiescent seed on admission; preserve private links and Git
   * read boundaries. The seed must not change while layered workspaces are mounted.
   */
  async populateAgentWorkspace(seed: Worktree, workspace: Worktree): Promise<void> {
    this.#signal?.throwIfAborted();
    if (!this.#agentWorkspaces.has(workspace.path) || (await readdir(workspace.path)).length !== 0)
      throw new Error('Agent workspace must be an empty reserved directory');
    try {
      const links = await this.#internalSeedLinks(seed);
      if ((await this.#agentWorkspaceLayout()) === 'overlay')
        await this.#mountLayer(seed, workspace);
      else
        await cp(seed.path, workspace.path, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
          filter: () => {
            this.#signal?.throwIfAborted();
            return true;
          },
        });
      for (const link of links) {
        this.#signal?.throwIfAborted();
        const path = join(workspace.path, link.path);
        await rm(path);
        await symlink(relative(dirname(path), join(workspace.path, link.target)) || '.', path);
      }
      this.#signal?.throwIfAborted();
    } catch (error) {
      await this.releaseAgentWorkspace(workspace);
      throw error;
    }
  }

  /** Keep the reserved root alive for every peer's canonical permission rules. */
  async releaseAgentWorkspace(workspace: Worktree): Promise<void> {
    if (!this.#agentWorkspaces.has(workspace.path)) throw new Error('Unknown Agent workspace');
    const layer = this.#layerMounts.get(workspace.path);
    if (layer !== undefined) {
      const layers = this.#requireLayers();
      await layers.unmount(workspace.path);
      this.#layerMounts.delete(workspace.path);
      await layers.remove(layer);
    }
    for (const name of await readdir(workspace.path))
      await rm(join(workspace.path, name), { recursive: true, force: true });
  }

  async materializeAgentWorkspace(seed: Worktree, agentKey: string): Promise<Worktree> {
    const workspace = await this.reserveAgentWorkspace(seed, agentKey);
    try {
      await this.populateAgentWorkspace(seed, workspace);
      return workspace;
    } catch (error) {
      await this.removeWorktree(workspace);
      throw error;
    }
  }

  /**
   * Remove a Review's worktree when the Review ends. Idempotent: a second removal
   * (or removal of a never-created worktree) is a no-op, so teardown can run on
   * both the success and failure paths without guarding.
   */
  async removeWorktree(worktree: Worktree): Promise<void> {
    if (this.#agentWorkspaces.has(worktree.path)) {
      if (this.#layerMounts.has(worktree.path)) await this.releaseAgentWorkspace(worktree);
      await rm(worktree.path, { recursive: true, force: true });
      return;
    }
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

  /** Resolve once per Review so the storage budget and every Agent agree on the layout. */
  #agentWorkspaceLayout(): Promise<AgentWorkspaceLayout> {
    this.#layout ??= this.#resolveAgentWorkspaceLayout();
    return this.#layout;
  }

  async #resolveAgentWorkspaceLayout(): Promise<AgentWorkspaceLayout> {
    if (this.#requestedLayout === 'copy') return 'copy';
    const fallback = (reason: string): AgentWorkspaceLayout => {
      this.#log?.(`Overlay Agent workspaces unavailable (${reason}); using private copies.`);
      return 'copy';
    };
    const layers = this.#layers;
    if (layers === undefined) return fallback('overlay mounts require Linux');
    const parent = join(this.#baseDir, '.agent-layers');
    await mkdir(parent, { recursive: true });
    const probe = await mkdtemp(join(parent, 'probe-'));
    const layer = {
      lower: join(probe, 'lower'),
      upper: join(probe, 'upper'),
      work: join(probe, 'work'),
      target: join(probe, 'target'),
    };
    try {
      for (const path of Object.values(layer)) await mkdir(path);
      await layers.mount(layer);
      await layers.unmount(layer.target);
    } catch (error) {
      await layers.remove(probe).catch(() => undefined);
      return fallback(error instanceof Error ? error.message : String(error));
    }
    await layers.remove(probe);
    this.#log?.('Agent workspaces are overlay layers over the read-only seed.');
    return 'overlay';
  }

  async #mountLayer(seed: Worktree, workspace: Worktree): Promise<void> {
    const layers = this.#requireLayers();
    const layer = join(
      this.#baseDir,
      '.agent-layers',
      relative(join(this.#baseDir, '.agent-workspaces'), workspace.path),
    );
    const mount = {
      lower: await realpath(seed.path),
      upper: join(layer, 'upper'),
      work: join(layer, 'work'),
      target: workspace.path,
    };
    // Mount options separate layers with ':' and options with ','.
    if ([mount.lower, mount.upper, mount.work].some((path) => /[,:\\]/.test(path)))
      throw new Error('Overlay layer paths cannot contain commas, colons or backslashes');
    await mkdir(mount.upper, { recursive: true });
    await mkdir(mount.work, { recursive: true });
    try {
      await layers.mount(mount);
    } catch (error) {
      await layers.remove(layer);
      throw error;
    }
    this.#layerMounts.set(workspace.path, layer);
  }

  #requireLayers(): WorkspaceLayers {
    if (this.#layers === undefined) throw new Error('Overlay mounts are unavailable');
    return this.#layers;
  }

  /** Scan the quiescent seed once per Review instead of walking every Agent workspace. */
  #internalSeedLinks(seed: Worktree): Promise<SeedLink[]> {
    let links = this.#seedLinks.get(seed.path);
    if (links === undefined) {
      links = (async () => {
        const found = await internalAbsoluteLinks(
          resolve(seed.path),
          await realpath(seed.path),
          this.#signal,
        );
        this.#log?.(
          `Prepared seed has ${found.length} absolute internal link${found.length === 1 ? '' : 's'} to rebase per Agent workspace.`,
        );
        return found;
      })();
      // A canceled or failed scan must not poison later attempts.
      links.catch(() => this.#seedLinks.delete(seed.path));
      this.#seedLinks.set(seed.path, links);
    }
    return links;
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
      await exec('git', ['-C', dest, 'rev-parse', '--is-inside-work-tree'], {
        timeout: 120_000,
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      });
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
      const { stdout } = await exec('git', args, {
        cwd,
        timeout: 120_000,
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      });
      return stdout;
    } catch (error) {
      const stderr =
        typeof error === 'object' && error !== null && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';
      const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
      throw new Error(
        `git ${args.map(redactCredentials).join(' ')} failed in ${cwd}: ${redactCredentialsInText(detail)}`,
      );
    }
  }
}

async function internalAbsoluteLinks(
  source: string,
  canonicalSource: string,
  signal: AbortSignal | undefined,
): Promise<SeedLink[]> {
  const links: SeedLink[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      signal?.throwIfAborted();
      const path = join(directory, entry);
      const info = await lstat(path);
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (!isAbsolute(target)) continue;
        const sourceRelative = [source, canonicalSource]
          .map((root) => relative(root, target))
          .find((value) => value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
        if (sourceRelative === undefined) continue;
        links.push({ path: relative(source, path), target: sourceRelative });
      }
    }
  };
  await visit(source);
  return links;
}

function redactCredentialsInText(value: string): string {
  return value.replaceAll(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+@[^\s'"]+/gi, (match) =>
    redactCredentials(match),
  );
}

function credentialFreeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}

function redactCredentials(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  if (url.username.length === 0 && url.password.length === 0) {
    return value;
  }
  url.username = 'redacted';
  url.password = 'redacted';
  return url.toString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
