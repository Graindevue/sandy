import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function readRepoText(root: string, relativePath: string): Promise<string | null> {
  return await readTextFile(join(root, relativePath));
}

export async function readRepoJson<T = unknown>(
  root: string,
  relativePath: string,
): Promise<T | null> {
  const text = await readRepoText(root, relativePath);
  if (text === null) {
    return null;
  }
  return JSON.parse(text) as T;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function listRepoFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, root, files);
  files.sort();
  return files;
}

async function walk(root: string, dir: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push(toPosix(relative(root, fullPath)));
  }
}

export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function parentDir(path: string): string {
  const dir = dirname(path);
  return dir === '.' ? '' : toPosix(dir);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
