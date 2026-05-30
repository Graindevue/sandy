import { parentDir, repoFileExists } from '../fs-utils.js';

export interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface PackageJsonFile {
  path: string;
  dir: string;
  json: PackageJson;
}

export async function loadPackageJsonFiles(context: {
  listFiles(): Promise<string[]>;
  readFile(relativePath: string): Promise<string | null>;
}): Promise<PackageJsonFile[]> {
  const files = (await context.listFiles()).filter((file) => file.endsWith('package.json'));
  const packages: PackageJsonFile[] = [];
  for (const path of files) {
    const text = await context.readFile(path);
    if (text === null) {
      continue;
    }
    const parsed = JSON.parse(text) as PackageJson;
    packages.push({ path, dir: parentDir(path), json: parsed });
  }
  return packages;
}

export async function resolveExistingEntryPath(
  root: string,
  packageDir: string,
  rawPath: string,
): Promise<string | null> {
  const withoutPrefix = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
  const base = packageDir.length === 0 ? withoutPrefix : `${packageDir}/${withoutPrefix}`;
  const candidates = entryCandidates(base);
  for (const candidate of candidates) {
    if (await repoFileExists(root, candidate)) {
      return candidate;
    }
  }
  return null;
}

function entryCandidates(base: string): string[] {
  const candidates = [base];
  if (!/\.[cm]?[tj]sx?$/.test(base)) {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`);
  }
  return candidates;
}
