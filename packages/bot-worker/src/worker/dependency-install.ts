import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** JS package managers the review install step knows how to drive. */
export type DetectedPackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface DetectedDependencyInstall {
  packageManager: DetectedPackageManager;
  /** Shell command that performs a lockfile-faithful install inside the native sandbox. */
  command: string;
  /** Runtime command using the reviewed Repo's package-manager pin when present. */
  packageManagerCommand?: string;
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
      /** Structured outcome; never inferred from reviewed stdout/stderr. */
      testStatus?: 'passed' | 'failed' | 'skipped';
      /** The test suite is run once, before Agents, with a bounded diagnostic tail. */
      testResult?: string;
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
 * hook installers are unnecessary during review and may otherwise alter shared
 * worktree git metadata (lefthook ignores CI=true, so disable it explicitly).
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
  const runtimeCommand = await packageManagerCommand(packageManager, worktreePath);
  return {
    packageManager,
    command: (await installCommand(packageManager, worktreePath)).replace(
      `${packageManager} `,
      `${runtimeCommand} `,
    ),
    ...(runtimeCommand !== packageManager ? { packageManagerCommand: runtimeCommand } : {}),
    ...(lockfile !== null ? { lockfile } : {}),
  };
}

async function packageManagerCommand(
  packageManager: DetectedPackageManager,
  worktreePath: string,
): Promise<string> {
  // pnpm's own version auto-install can replace the executing CLI. An explicit
  // npx pin keeps Sandy's tooling separate from the reviewed Repo's version.
  if (packageManager !== 'pnpm') return packageManager;
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(worktreePath, 'package.json'), 'utf8'));
  } catch {
    return packageManager;
  }
  if (typeof manifest !== 'object' || manifest === null) return packageManager;
  const pin = (manifest as { packageManager?: unknown }).packageManager;
  if (typeof pin !== 'string' || !pin.startsWith('pnpm@')) return packageManager;
  const match =
    /^pnpm@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.exec(
      pin,
    );
  if (match?.[1] === undefined)
    throw new Error('packageManager pnpm pin must be an exact semantic version');
  return `npx --yes pnpm@${match[1]}`;
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
      // Reuse the runner's package-manager cache without rewriting the lockfile.
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
