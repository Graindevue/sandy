import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

/** Trusted-parent reads must never follow a reviewed manifest into credentials. */
export async function readPackageJson(
  worktreePath: string,
): Promise<{ bytes: Buffer; mode: number }> {
  const path = join(worktreePath, 'package.json');
  const invalidFile = () => new Error('package.json must be a regular file');
  if (!(await lstat(path)).isFile()) throw invalidFile();
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw invalidFile();
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw invalidFile();
    return { bytes: await file.readFile(), mode: metadata.mode & 0o777 };
  } finally {
    await file.close();
  }
}

/** CI disables Lefthook's npm postinstall, but explicit `lefthook install` ignores it. */
export async function installWithoutHookOnlyPrepare<T>(
  worktreePath: string,
  install: () => Promise<T>,
): Promise<T> {
  const original = await readPackageJson(worktreePath);
  const manifest = JSON.parse(original.bytes.toString('utf8')) as {
    scripts?: Record<string, unknown>;
  };
  if (manifest.scripts?.prepare !== 'lefthook install') return install();
  const { prepare: _, ...scripts } = manifest.scripts;
  try {
    await replacePackageJson(worktreePath, JSON.stringify({ ...manifest, scripts }), original.mode);
    return await install();
  } finally {
    // A reviewed lifecycle may replace package.json with a credential symlink.
    // Rename replaces that directory entry without opening the symlink target.
    await replacePackageJson(worktreePath, original.bytes, original.mode);
  }
}

async function replacePackageJson(worktreePath: string, bytes: string | Buffer, mode: number) {
  // The managed worktree's parent is outside the reviewed write grant, so
  // lifecycle code cannot replace this temporary entry during restoration.
  const temporaryPath = join(dirname(worktreePath), `.sandy-package-json-${randomUUID()}`);
  try {
    const file = await open(temporaryPath, 'wx', mode);
    try {
      await file.writeFile(bytes);
      await file.chmod(mode);
    } finally {
      await file.close();
    }
    await rename(temporaryPath, join(worktreePath, 'package.json'));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Decide how to install the reviewed Repo's dependencies.
 *
 * The `packageManager` field is authoritative when present; otherwise the
 * lockfile decides. Returns null when the worktree has no `package.json` —
 * a non-JS Repo gets no install step at all.
 *
 * Every command runs with a frozen lockfile, so the install can never
 * rewrite the lockfile under review, plus `CI=true LEFTHOOK=0 HUSKY=0`:
 * hook execution is unnecessary during review. The runner omits an exact
 * hook-only Lefthook prepare while preserving other dependency lifecycles.
 */
export async function detectDependencyInstall(
  worktreePath: string,
): Promise<DetectedDependencyInstall | null> {
  if (!(await pathExists(join(worktreePath, 'package.json')))) {
    return null;
  }
  await readPackageJson(worktreePath);

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
    manifest = JSON.parse((await readPackageJson(worktreePath)).bytes.toString('utf8'));
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
    manifest = JSON.parse((await readPackageJson(worktreePath)).bytes.toString('utf8'));
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
