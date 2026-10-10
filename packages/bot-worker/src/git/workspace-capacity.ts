import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceCapacity {
  seedBytes: number;
  availableBytes: number;
  requiredBytes: number;
  reserveBytes: number;
  fits: boolean;
}

/** Budget ordinary copies: reflink support is filesystem dependent. Never follow source links. */
export async function agentWorkspaceCapacity(
  seedPath: string,
  destinationParent: string,
  workspaceCount: number,
  signal?: AbortSignal,
): Promise<WorkspaceCapacity> {
  if (!Number.isSafeInteger(workspaceCount) || workspaceCount < 1)
    throw new Error('Invalid private workspace count');
  const filesystem = await statfs(destinationParent);
  const block = filesystem.bsize;
  let seedBytes = 0;
  const pending = [seedPath];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const path = pending.pop();
    if (path === undefined) break;
    const entry = await lstat(path);
    if (entry.isDirectory()) {
      seedBytes += block;
      for (const name of await readdir(path)) pending.push(join(path, name));
    } else if (entry.isFile()) {
      // cp duplicates hardlinks and may allocate sparse files fully.
      seedBytes += Math.ceil(entry.size / block) * block;
    } else if (entry.isSymbolicLink()) seedBytes += block;
    else throw new Error('Private workspace contains an unsupported file type');
  }
  const availableBytes = filesystem.bavail * block;
  // Leave room for each Agent's focused builds, logs and test outputs.
  const reserveBytes = workspaceCount * 1024 ** 3;
  const requiredBytes = seedBytes * workspaceCount + reserveBytes;
  return {
    seedBytes,
    availableBytes,
    requiredBytes,
    reserveBytes,
    fits: requiredBytes <= availableBytes,
  };
}
