import type { ApiSurfaceExtractor, JsonValue } from '@sandy/shared-types';
import { code, renderMarkdownTable } from '../markdown.js';
import { loadPackageJsonFiles } from './package-json.js';

interface FrameworkVersionEntry {
  packageName: string;
  declared: string[];
  resolved: string | null;
  manifests: string[];
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const extractor: ApiSurfaceExtractor = {
  key: 'framework-versions',
  title: 'Framework Versions',
  async extract(context) {
    const packageFiles = await loadPackageJsonFiles(context);
    const declared = new Map<string, { declared: Set<string>; manifests: Set<string> }>();

    for (const pkg of packageFiles) {
      for (const field of DEPENDENCY_FIELDS) {
        const deps = pkg.json[field] ?? {};
        for (const [packageName, range] of Object.entries(deps)) {
          const entry = declared.get(packageName) ?? {
            declared: new Set<string>(),
            manifests: new Set<string>(),
          };
          entry.declared.add(`${field}:${range}`);
          entry.manifests.add(pkg.path);
          declared.set(packageName, entry);
        }
      }
    }

    const lockfiles = await loadLockfiles(context.readFile);
    const entries: FrameworkVersionEntry[] = [...declared.entries()]
      .map(([packageName, entry]) => ({
        packageName,
        declared: [...entry.declared].sort(),
        resolved: resolveVersion(lockfiles, packageName),
        manifests: [...entry.manifests].sort(),
      }))
      .sort((a, b) => a.packageName.localeCompare(b.packageName));

    return {
      data: entries as unknown as JsonValue,
      markdown: renderMarkdownTable(
        ['Package', 'Declared', 'Resolved', 'Declared In'],
        entries.map((entry) => [
          code(entry.packageName),
          entry.declared.map(code).join('<br>'),
          entry.resolved === null ? '' : code(entry.resolved),
          entry.manifests.map(code).join('<br>'),
        ]),
      ),
    };
  },
};

export default extractor;

async function loadLockfiles(
  readFile: (path: string) => Promise<string | null>,
): Promise<string[]> {
  const lockfiles = await Promise.all(
    ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].map(async (path) => ({
      path,
      text: await readFile(path),
    })),
  );
  return lockfiles.flatMap((lockfile) => (lockfile.text === null ? [] : [lockfile.text]));
}

function resolveVersion(lockfiles: readonly string[], packageName: string): string | null {
  for (const lockfile of lockfiles) {
    const version =
      resolveFromPackageLock(lockfile, packageName) ?? resolveFromTextLock(lockfile, packageName);
    if (version !== null) {
      return version;
    }
  }
  return null;
}

function resolveFromPackageLock(lockfile: string, packageName: string): string | null {
  if (!lockfile.trimStart().startsWith('{')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockfile);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('packages' in parsed)) {
    return null;
  }
  const packages = (parsed as { packages?: unknown }).packages;
  if (typeof packages !== 'object' || packages === null) {
    return null;
  }
  const nodeModule = (packages as Record<string, unknown>)[`node_modules/${packageName}`];
  if (typeof nodeModule !== 'object' || nodeModule === null || !('version' in nodeModule)) {
    return null;
  }
  const version = (nodeModule as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

function resolveFromTextLock(lockfile: string, packageName: string): string | null {
  const escaped = escapeRegExp(packageName);
  const patterns = [
    new RegExp(`^[\\s"']*/?${escaped}@([^\\s:'"()]+)`, 'm'),
    new RegExp(`^[\\s"']*${escaped}@npm:[^\\s:'"]+:[\\s\\n]+\\s+version:\\s*([^\\s]+)`, 'm'),
  ];
  for (const pattern of patterns) {
    const match = lockfile.match(pattern);
    if (match?.[1] !== undefined) {
      return match[1].replaceAll('"', '').replaceAll("'", '');
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
