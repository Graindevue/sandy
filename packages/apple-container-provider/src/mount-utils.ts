/**
 * Mount helpers mirrored from @ai-hero/sandcastle mountUtils (not on the public
 * package surface).
 *
 * Originally developed for graindevue's sandcastle integration; copied into
 * Sandy and MIT-relicensed per ADR 0009, intended to be upstreamed to
 * `@ai-hero/sandcastle` over time.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { MountConfig } from '@ai-hero/sandcastle';

const SANDBOX_REPO_DIR = '/home/agent/workspace';

const expandTilde = (p: string, homeDirPath?: string): string => {
  const home = homeDirPath ?? homedir();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return `${home}/${p.slice(2)}`;
  return p;
};

const resolveHostPath = (hostPath: string): string => {
  const expanded = expandTilde(hostPath);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
};

const resolveSandboxPath = (sandboxPath: string, sandboxHomedir?: string): string => {
  const hasTilde =
    sandboxPath === '~' || sandboxPath.startsWith('~/') || sandboxPath.startsWith('~\\');
  if (hasTilde && sandboxHomedir === undefined) {
    throw new Error(
      `sandboxPath "${sandboxPath}" contains a tilde but the provider has no sandboxHomedir set`,
    );
  }
  const expanded = hasTilde ? expandTilde(sandboxPath, sandboxHomedir) : sandboxPath;
  return isAbsolute(expanded) ? expanded : resolve(SANDBOX_REPO_DIR, expanded);
};

export const resolveUserMounts = (
  mounts: readonly MountConfig[],
  sandboxHomedir?: string,
): Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }> =>
  mounts.map((m) => {
    const resolvedHostPath = resolveHostPath(m.hostPath);

    if (!existsSync(resolvedHostPath)) {
      throw new Error(
        `Mount hostPath does not exist: ${m.hostPath}` +
          (m.hostPath !== resolvedHostPath ? ` (resolved to ${resolvedHostPath})` : ''),
      );
    }

    return {
      hostPath: resolvedHostPath,
      sandboxPath: resolveSandboxPath(m.sandboxPath, sandboxHomedir),
      ...(m.readonly ? { readonly: true } : {}),
    };
  });

export const processFileMountParents = (
  mounts: ReadonlyArray<{ hostPath: string; sandboxPath: string }>,
  sandboxHomedir: string,
  statFn: (path: string) => { isFile(): boolean } = statSync,
): string[] => {
  const parentDirs = new Set<string>();

  for (const mount of mounts) {
    let isFile: boolean;
    try {
      isFile = statFn(mount.hostPath).isFile();
    } catch {
      continue;
    }

    if (!isFile) continue;

    const parentDir = dirname(mount.sandboxPath);

    if (parentDir === sandboxHomedir) continue;

    if (!parentDir.startsWith(`${sandboxHomedir}/`)) {
      throw new Error(
        `Cannot mount file to '${mount.sandboxPath}': ` +
          `parent directory '${parentDir}' is outside the sandbox home directory ('${sandboxHomedir}'). ` +
          `Mount the parent directory instead, or rebuild the image with '${parentDir}' pre-created.`,
      );
    }

    parentDirs.add(parentDir);
  }

  return [...parentDirs];
};

export const formatVolumeMount = (mount: {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
}): string => {
  const base = `${mount.hostPath}:${mount.sandboxPath}`;
  return mount.readonly ? `${base}:ro` : base;
};
