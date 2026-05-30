import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  const path = await resolveRepoFilePath(root, relativePath);
  return path === null ? null : await readTextFile(path);
}

export async function repoFileExists(root: string, relativePath: string): Promise<boolean> {
  return (await resolveRepoFilePath(root, relativePath)) !== null;
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

async function resolveRepoFilePath(root: string, relativePath: string): Promise<string | null> {
  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, relativePath);
  if (!isWithin(rootPath, targetPath)) {
    return null;
  }

  try {
    const [realRoot, realTarget] = await Promise.all([realpath(rootPath), realpath(targetPath)]);
    if (!isWithin(realRoot, realTarget)) {
      return null;
    }
    return (await stat(realTarget)).isFile() ? realTarget : null;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
