import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { adoptDownloadStore } from './dependency-download-cache.js';

const rename = vi.hoisted(() => ({ error: undefined as NodeJS.ErrnoException | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      if (rename.error !== undefined) throw rename.error;
      return actual.rename(source, destination);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  rename.error = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function restoredStore(): Promise<{ source: string; destination: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sandy-download-store-'));
  directories.push(root);
  const source = join(root, 'restored');
  const file = join('v10', 'files', '0a', 'b'.repeat(62));
  await mkdir(join(source, 'v10', 'files', '0a'), { recursive: true });
  await writeFile(join(source, file), 'package bytes');
  const destination = join(root, 'install');
  await mkdir(destination);
  await writeFile(join(destination, 'stale'), 'previous review');
  return { source, destination, file };
}

it('moves a restored store into place on the same device', async () => {
  const { source, destination, file } = await restoredStore();
  await adoptDownloadStore(source, destination, 'pnpm');
  expect(await readFile(join(destination, file), 'utf8')).toBe('package bytes');
  await expect(stat(join(destination, 'stale'))).rejects.toThrow();
  await expect(stat(source)).rejects.toThrow();
});

it('copies a restored store that lives on another device', async () => {
  const { source, destination, file } = await restoredStore();
  rename.error = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  await adoptDownloadStore(source, destination, 'pnpm');
  expect(await readFile(join(destination, file), 'utf8')).toBe('package bytes');
  await expect(stat(join(destination, 'stale'))).rejects.toThrow();
});

it('reports other move failures instead of copying', async () => {
  const { source, destination } = await restoredStore();
  rename.error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  await expect(adoptDownloadStore(source, destination, 'pnpm')).rejects.toThrow(
    'permission denied',
  );
});
