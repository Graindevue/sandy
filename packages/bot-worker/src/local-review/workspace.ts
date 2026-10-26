import { mkdir, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CloneManager } from '../git/clone-manager.js';
import type {
  RepoForWorktree,
  ReviewCloneManager,
  ReviewWorktree,
  WorktreeRequest,
} from '../worker/review-executor.js';
import { type RemoteRepository, type ReviewBase, runGit, siblingCloneUrl } from './git.js';
import { type LocalReviewHome, pathExists, removeTree } from './home.js';

const HEAD_REF = 'refs/sandy/head';
const BASE_REF = 'refs/sandy/base';

/** Settings git would otherwise take from the developer's global config. */
const MIRROR_CONFIG: readonly (readonly [string, string])[] = [
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['gc.auto', '0'],
  // Local receive-pack reads this config, not `-c` values from the pushing side.
  ['receive.fsckObjects', 'false'],
  // A shallow checkout's commits need shallow roots in the mirror.
  ['receive.shallowUpdate', 'true'],
  ['transfer.fsckObjects', 'false'],
];

export interface LocalCloneManagerOptions {
  home: LocalReviewHome;
  reviewId: string;
  /** The developer's checkout; commits are read from it and nothing is written to it. */
  checkoutRoot: string;
  originUrl: string | null;
  reviewed: RemoteRepository;
  headSha: string;
  base: ReviewBase;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/**
 * Review worktrees that never expose the developer's checkout. The reviewed
 * Repo is pushed into a fresh bare mirror that holds only the history of the
 * head and base commits, so uncommitted work, stashes, other branches, and
 * the checkout's Git config never reach an Agent. Sibling Repos are cloned
 * from the origin host at their default branch, as in CI.
 */
export class LocalCloneManager implements ReviewCloneManager {
  readonly #options: LocalCloneManagerOptions;
  readonly #mirror: string;
  readonly #siblings: CloneManager;
  #published: Promise<void> | undefined;

  constructor(options: LocalCloneManagerOptions) {
    this.#options = options;
    this.#mirror = join(options.home.mirrors, options.reviewId, `${options.reviewed.name}.git`);
    this.#siblings = new CloneManager({
      baseDir: options.home.repos,
      cloneUrl: (repo) => siblingCloneUrl(options.originUrl, repo),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  }

  /** Path a sibling Repo is cloned to; the reviewed Repo is read from the checkout. */
  siblingPath(repo: RepoForWorktree): string {
    return this.#siblings.repoPath(repo);
  }

  async ensureCloned(repo: RepoForWorktree): Promise<string> {
    if (!this.#isReviewed(repo)) return await this.#siblings.ensureCloned(repo);
    this.#published ??= this.#publish();
    await this.#published;
    return this.#mirror;
  }

  async resolveDefaultBranchSha(repo: RepoForWorktree): Promise<string> {
    if (!this.#isReviewed(repo)) return await this.#siblings.resolveDefaultBranchSha(repo);
    return this.#options.base.sha;
  }

  async createWorktree(repo: RepoForWorktree, request: WorktreeRequest): Promise<ReviewWorktree> {
    if (!this.#isReviewed(repo)) return await this.#siblings.createWorktree(repo, request);
    await this.ensureCloned(repo);
    const path = join(this.#options.home.worktrees, request.reviewJobId, repo.name);
    await removeTree(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Pointer files stay in place of Git LFS content; the mirror has no LFS remote.
    await this.#mirrorGit(['worktree', 'add', '--detach', '--quiet', path, request.sha], {
      GIT_LFS_SKIP_SMUDGE: '1',
    });
    return { repo, path, sha: request.sha, reviewJobId: request.reviewJobId };
  }

  async removeWorktree(worktree: ReviewWorktree): Promise<void> {
    if (!this.#isReviewed(worktree.repo)) {
      await this.#siblings.removeWorktree(worktree);
      return;
    }
    await removeTree(worktree.path);
    await removeTree(dirname(this.#mirror));
    this.#published = undefined;
    await rmdir(dirname(worktree.path)).catch(() => {});
  }

  async #publish(): Promise<void> {
    const { base, checkoutRoot, headSha, signal } = this.#options;
    await removeTree(dirname(this.#mirror));
    await mkdir(dirname(this.#mirror), { recursive: true, mode: 0o700 });
    // An empty template directory keeps the developer's template hooks out.
    await runGit(
      dirname(this.#mirror),
      ['init', '--bare', '--quiet', '--template=', this.#mirror],
      {
        ...(signal === undefined ? {} : { signal }),
      },
    );
    for (const [key, value] of MIRROR_CONFIG) await this.#mirrorGit(['config', key, value]);
    // Push only the two commits a Review needs. A local clone would hardlink
    // every object, including stashes and unreachable work. From a shallow
    // checkout, receive-pack fails every ref after the first in one push.
    for (const refspec of [`${headSha}:${HEAD_REF}`, `${base.sha}:${mirrorBaseRef(base)}`]) {
      await runGit(
        checkoutRoot,
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'push.gpgSign=false',
          'push',
          '--no-verify',
          '--force',
          '--quiet',
          '--no-follow-tags',
          '--recurse-submodules=no',
          this.#mirror,
          refspec,
        ],
        signal === undefined ? {} : { signal },
      );
    }
  }

  async #mirrorGit(args: readonly string[], env?: Readonly<Record<string, string>>) {
    const { signal } = this.#options;
    return await runGit(
      dirname(this.#mirror),
      [
        `--git-dir=${this.#mirror}`,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      { ...(env === undefined ? {} : { env }), ...(signal === undefined ? {} : { signal }) },
    );
  }

  #isReviewed(repo: RepoForWorktree): boolean {
    const { reviewed } = this.#options;
    return (
      repo.owner.toLowerCase() === reviewed.owner.toLowerCase() &&
      repo.name.toLowerCase() === reviewed.name.toLowerCase()
    );
  }
}

/** Keep the base's own ref name so Agents can run `git diff origin/main...HEAD` as in CI. */
export function mirrorBaseRef(base: ReviewBase): string {
  const ref = base.fullRef;
  if (ref === null || ref === HEAD_REF) return BASE_REF;
  return ['refs/heads/', 'refs/remotes/', 'refs/tags/'].some((prefix) => ref.startsWith(prefix))
    ? ref
    : BASE_REF;
}

/** Drop worktrees, mirrors, and sibling worktrees an interrupted Review left behind. */
export async function clearInterruptedReviews(home: LocalReviewHome): Promise<void> {
  for (const path of [home.worktrees, home.mirrors, join(home.repos, '.worktrees')]) {
    if (await pathExists(path)) await removeTree(path);
  }
}
