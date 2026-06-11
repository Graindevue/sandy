import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectDependencyInstall } from './dependency-install.js';

const createdDirs: string[] = [];

async function makeWorktree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sandy-dependency-install-'));
  createdDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('detectDependencyInstall', () => {
  it('returns null when the worktree has no package.json', async () => {
    const dir = await makeWorktree({ 'pnpm-lock.yaml': '' });

    await expect(detectDependencyInstall(dir)).resolves.toBeNull();
  });

  it('returns null for a package.json with no packageManager and no lockfile', async () => {
    const dir = await makeWorktree({ 'package.json': '{}' });

    await expect(detectDependencyInstall(dir)).resolves.toBeNull();
  });

  it('detects pnpm from the lockfile with a frozen, offline-preferring install', async () => {
    const dir = await makeWorktree({ 'package.json': '{}', 'pnpm-lock.yaml': '' });

    await expect(detectDependencyInstall(dir)).resolves.toEqual({
      packageManager: 'pnpm',
      command: 'CI=true LEFTHOOK=0 HUSKY=0 pnpm install --frozen-lockfile --prefer-offline',
      lockfile: 'pnpm-lock.yaml',
    });
  });

  it('lets the packageManager field override lockfile detection', async () => {
    const dir = await makeWorktree({
      'package.json': '{"packageManager":"pnpm@10.24.0"}',
      'package-lock.json': '{}',
    });

    await expect(detectDependencyInstall(dir)).resolves.toMatchObject({ packageManager: 'pnpm' });
  });

  it('detects npm ci from package-lock.json', async () => {
    const dir = await makeWorktree({ 'package.json': '{}', 'package-lock.json': '{}' });

    await expect(detectDependencyInstall(dir)).resolves.toEqual({
      packageManager: 'npm',
      command: 'CI=true LEFTHOOK=0 HUSKY=0 npm ci --prefer-offline --no-audit --no-fund',
      lockfile: 'package-lock.json',
    });
  });

  it('detects yarn classic from yarn.lock', async () => {
    const dir = await makeWorktree({ 'package.json': '{}', 'yarn.lock': '' });

    await expect(detectDependencyInstall(dir)).resolves.toEqual({
      packageManager: 'yarn',
      command: 'CI=true LEFTHOOK=0 HUSKY=0 yarn install --frozen-lockfile',
      lockfile: 'yarn.lock',
    });
  });

  it('detects yarn berry from .yarnrc.yml and uses --immutable', async () => {
    const dir = await makeWorktree({ 'package.json': '{}', 'yarn.lock': '', '.yarnrc.yml': '' });

    await expect(detectDependencyInstall(dir)).resolves.toEqual({
      packageManager: 'yarn',
      command: 'CI=true LEFTHOOK=0 HUSKY=0 yarn install --immutable',
      lockfile: 'yarn.lock',
    });
  });

  it('detects bun from bun.lockb', async () => {
    const dir = await makeWorktree({ 'package.json': '{}', 'bun.lockb': '' });

    await expect(detectDependencyInstall(dir)).resolves.toEqual({
      packageManager: 'bun',
      command: 'CI=true LEFTHOOK=0 HUSKY=0 bun install --frozen-lockfile',
      lockfile: 'bun.lockb',
    });
  });

  it('falls back to lockfile detection when package.json is unparseable', async () => {
    const dir = await makeWorktree({ 'package.json': 'not json', 'pnpm-lock.yaml': '' });

    await expect(detectDependencyInstall(dir)).resolves.toMatchObject({ packageManager: 'pnpm' });
  });

  it('ignores an unknown packageManager name and uses the lockfile', async () => {
    const dir = await makeWorktree({
      'package.json': '{"packageManager":"vlt@1.0.0"}',
      'pnpm-lock.yaml': '',
    });

    await expect(detectDependencyInstall(dir)).resolves.toMatchObject({ packageManager: 'pnpm' });
  });
});
