import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** JS package managers the review install step knows how to drive. */
export type DetectedPackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface DetectedDependencyInstall {
  packageManager: DetectedPackageManager;
  /** Shell command that performs a lockfile-faithful install inside the sandbox. */
  command: string;
  /** Lockfile present in the worktree, when one exists — keys the node_modules seed cache. */
  lockfile?: string;
}

/**
 * Outcome of the once-per-Review dependency install, threaded into every
 * Agent prompt so Agents know whether package scripts and tests are runnable
 * (fail-loud, per docs/prds/feature-run-tests-in-reviews.md).
 */
export type DependencyInstallResult =
  | {
      status: 'installed';
      packageManager: DetectedPackageManager;
      command: string;
      durationMs: number;
    }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string; command?: string };

/**
 * Decide how to install the reviewed Repo's dependencies.
 *
 * The `packageManager` field is authoritative when present; otherwise the
 * lockfile decides. Returns null when the worktree has no `package.json` —
 * a non-JS Repo gets no install step at all.
 *
 * Every command runs with a frozen lockfile, so the install can never
 * rewrite the lockfile under review, plus `CI=true LEFTHOOK=0 HUSKY=0`:
 * git-hook installers run from `prepare` scripts need the host gitdir, which
 * is not mounted in the install VM (observed: graindevue's `lefthook install`
 * fails with "not a git repository" — lefthook ignores CI=true).
 */
export async function detectDependencyInstall(
  worktreePath: string,
): Promise<DetectedDependencyInstall | null> {
  if (!(await pathExists(join(worktreePath, 'package.json')))) {
    return null;
  }

  const fromLockfile = await packageManagerFromLockfile(worktreePath);
  const packageManager =
    (await packageManagerFromManifest(worktreePath)) ?? fromLockfile?.packageManager ?? null;
  if (packageManager === null) {
    return null;
  }

  const lockfile =
    fromLockfile !== null && fromLockfile.packageManager === packageManager
      ? fromLockfile.lockfile
      : null;
  return {
    packageManager,
    command: await installCommand(packageManager, worktreePath),
    ...(lockfile !== null ? { lockfile } : {}),
  };
}

async function packageManagerFromManifest(
  worktreePath: string,
): Promise<DetectedPackageManager | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(worktreePath, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof manifest !== 'object' || manifest === null) {
    return null;
  }
  const field = (manifest as { packageManager?: unknown }).packageManager;
  if (typeof field !== 'string') {
    return null;
  }
  const name = field.split('@')[0];
  return name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun' ? name : null;
}

async function packageManagerFromLockfile(
  worktreePath: string,
): Promise<{ packageManager: DetectedPackageManager; lockfile: string } | null> {
  const lockfiles: [string, DetectedPackageManager][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];
  for (const [lockfile, packageManager] of lockfiles) {
    if (await pathExists(join(worktreePath, lockfile))) {
      return { packageManager, lockfile };
    }
  }
  return null;
}

async function installCommand(
  packageManager: DetectedPackageManager,
  worktreePath: string,
): Promise<string> {
  switch (packageManager) {
    case 'pnpm':
      // --prefer-offline skips registry metadata re-checks for anything the
      // VM-local store already has (e.g. on a seeded near-no-op install).
      return 'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline';
    case 'npm':
      return 'CI=true LEFTHOOK=0 HUSKY=0 npm ci --prefer-offline --no-audit --no-fund';
    case 'yarn':
      // Berry (.yarnrc.yml) renamed classic's --frozen-lockfile to --immutable.
      return (await pathExists(join(worktreePath, '.yarnrc.yml')))
        ? 'CI=true LEFTHOOK=0 HUSKY=0 yarn install --immutable'
        : 'CI=true LEFTHOOK=0 HUSKY=0 yarn install --frozen-lockfile';
    case 'bun':
      return 'CI=true LEFTHOOK=0 HUSKY=0 bun install --frozen-lockfile';
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
