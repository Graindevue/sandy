import { link, mkdir, mkdtemp, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { agentWorkspaceCapacity } from './workspace-capacity.js';

it('budgets independent copies of hardlinks and never follows foreign symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandy-storage-'));
  try {
    const seed = join(root, 'seed');
    await mkdir(seed);
    const { bsize } = await statfs(root);
    await writeFile(join(seed, 'dependency'), Buffer.alloc(bsize + 1));
    await link(join(seed, 'dependency'), join(seed, 'hardlink'));
    await mkdir(join(root, 'external'));
    await writeFile(join(root, 'external', 'large'), Buffer.alloc(bsize * 100));
    await symlink(join(root, 'external'), join(seed, 'foreign'));
    const capacity = await agentWorkspaceCapacity(seed, root, 3);
    expect(capacity.seedBytes).toBe(6 * bsize);
    expect(capacity.reserveBytes).toBe(3 * 1024 ** 3);
    expect(capacity.requiredBytes).toBe(18 * bsize + 3 * 1024 ** 3);
    expect(capacity.availableBytes).toBeGreaterThan(0);
    await expect(agentWorkspaceCapacity(seed, root, 3, AbortSignal.abort())).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
