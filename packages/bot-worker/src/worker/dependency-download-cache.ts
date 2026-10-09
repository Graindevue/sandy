import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, type FileHandle, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { DetectedDependencyInstall, DetectedPackageManager } from './dependency-install.js';
import { readPackageJson } from './dependency-install.js';

export interface DependencyDownloadCacheInput {
  key: string;
  /** A dedicated download store, never HOME or an installed dependency tree. */
  storePath: string;
  signal?: AbortSignal;
}

/** External cache-service boundary; a miss or service failure never prevents installation. */
export interface DependencyDownloadCache {
  restore(input: DependencyDownloadCacheInput): Promise<string | undefined>;
  save(input: DependencyDownloadCacheInput): Promise<void>;
}

export interface DependencyDownloadCacheMetrics {
  restore: 'hit' | 'miss' | 'unavailable' | 'unverified' | 'discarded';
  restoreMs: number;
  fetchMs: number;
  save: 'saved' | 'skipped' | 'unavailable';
  saveMs: number;
  coldRetry: boolean;
}

export async function dependencyDownloadCacheKey(input: {
  worktreePath: string;
  repository?: string;
  detected: DetectedDependencyInstall;
}): Promise<{ key: string; version: string } | undefined> {
  if (!input.repository || !input.detected.lockfile) return undefined;
  if (input.detected.packageManager !== 'npm' && input.detected.packageManager !== 'pnpm')
    return undefined;
  try {
    const manifestBytes = (await readPackageJson(input.worktreePath)).bytes;
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { packageManager?: unknown };
    if (typeof manifest.packageManager !== 'string') return undefined;
    const pin =
      /^(npm|pnpm)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.exec(
        manifest.packageManager,
      );
    if (!pin?.[2] || pin[1] !== input.detected.packageManager) return undefined;
    const digest = createHash('sha256');
    digest.update(manifestBytes);
    for (const name of [
      input.detected.lockfile,
      '.npmrc',
      'pnpm-workspace.yaml',
      '.pnpmfile.cjs',
      'pnpmfile.cjs',
    ]) {
      const bytes = await readConfiguration(join(input.worktreePath, name));
      if (name === input.detected.lockfile && bytes === undefined) return undefined;
      if (bytes !== undefined) {
        // Fetch URLs and registry configuration can embed credentials in cache metadata.
        if (
          /(?:_auth(?:Token)?|password|username)\s*[:=]|https?:\/\/[^\s/]+@/i.test(
            bytes.toString('utf8'),
          )
        )
          return undefined;
        digest.update(name).update('\0').update(bytes).update('\0');
      }
    }
    const repository = createHash('sha256').update(input.repository.toLowerCase()).digest('hex');
    return {
      key: `sandy-downloads-v1-${repository}-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}-${manifest.packageManager}-${digest.digest('hex')}`,
      version: pin[2],
    };
  } catch {
    return undefined;
  }
}

async function readConfiguration(path: string): Promise<Buffer | undefined> {
  let file: FileHandle | undefined;
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Cache configuration must be regular');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024)
      throw new Error('Unverified configuration');
    return await file.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

/** Restored archives and lifecycle-modified stores cannot point host reads outside the store. */
export async function validateDownloadStore(
  path: string,
  manager: DetectedPackageManager,
): Promise<void> {
  if (manager !== 'npm' && manager !== 'pnpm') throw new Error('Unsupported download store');
  const pending = [path];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    if (!(await lstat(directory)).isDirectory()) throw new Error('Unsafe download store');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 250_000) throw new Error('Download store exceeds validation budget');
      const entryPath = join(directory, entry.name);
      const parts = relative(path, entryPath).split(/[\\/]/);
      const allowed =
        manager === 'npm'
          ? /^(?:content-v2|index-v5|tmp)$/.test(parts[0] ?? '') &&
            parts.slice(1).every((part) => /^[a-f0-9]+$|^sha(?:1|256|384|512)$/.test(part))
          : /^v\d+$/.test(parts[0] ?? '') &&
            parts
              .slice(1)
              .every((part) =>
                /^(?:files|index|index\.db(?:-wal|-shm)?|[a-f0-9]{2}|[a-f0-9]{62,}(?:[^/]*)?)$/.test(
                  part,
                ),
              );
      if (!allowed || (parts[0] === 'tmp' && parts.length > 1))
        throw new Error('Unexpected download-store entry');
      if (entry.isDirectory()) pending.push(entryPath);
      else if (!entry.isFile()) throw new Error('Unsafe download-store entry');
    }
  }
}

export async function resetDownloadStore(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

/** pnpm's store also tracks local project installations; those records are not downloads. */
export async function discardMutableStoreState(
  path: string,
  manager: DetectedPackageManager,
): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error('Unsafe download store');
  if (manager === 'npm') {
    await rm(join(path, 'tmp'), { recursive: true, force: true });
  } else if (manager === 'pnpm') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (/^v\d+$/.test(entry.name) && entry.isDirectory())
        await rm(join(path, entry.name, 'projects'), { recursive: true, force: true });
    }
  }
}

/** Copy only data; symlinks and special files are rejected without following their targets. */
export async function snapshotDownloadStore(
  source: string,
  destination: string,
  manager: DetectedPackageManager,
): Promise<void> {
  await validateDownloadStore(source, manager);
  await resetDownloadStore(destination);
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: async (path) => {
      const entry = await lstat(path);
      if (!entry.isFile() && !entry.isDirectory()) throw new Error('Unsafe download-store entry');
      return true;
    },
  });
  await validateDownloadStore(destination, manager);
}
