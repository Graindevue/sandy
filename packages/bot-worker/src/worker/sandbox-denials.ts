import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The pinned Linux sandbox cannot mount a child mask inside a frozen parent mask. */
export async function minimalSandboxDenials(
  paths: readonly string[],
  grantedPaths: readonly string[],
): Promise<string[]> {
  const entries = await Promise.all(
    [...new Set(paths.map((path) => resolve(path)))].map(async (path) => ({
      path,
      canonical: await canonicalPath(path),
    })),
  );
  const denied = [...new Map(entries.map((entry) => [entry.canonical, entry])).values()];
  const grants = await Promise.all(grantedPaths.map(canonicalPath));
  return denied
    .filter(
      ({ canonical: path }) =>
        !denied.some(
          ({ canonical: parent }) =>
            parent !== path &&
            contains(parent, path) &&
            // A nested grant can reopen this child; its explicit deny must survive.
            !grants.some((grant) => contains(parent, grant) && contains(grant, path)),
        ),
    )
    .map(({ path }) => path);
}

async function canonicalPath(path: string): Promise<string> {
  path = resolve(path);
  try {
    return await realpath(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
    )
      throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    // Missing protected children can still have an existing symlinked ancestor.
    return join(await canonicalPath(parent), basename(path));
  }
}

function contains(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
