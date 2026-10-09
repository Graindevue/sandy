import type { ApiSurfaceExtractor, JsonValue } from '@sandy/shared-types';
import { code, oneLine, renderBulletList } from '../markdown.js';
import { loadPackageJsonFiles, resolveExistingEntryPath } from './package-json.js';

interface NpmExportEntry {
  packageName: string;
  entrypoint: string;
  path: string;
  symbols: ExportedSymbol[];
}

interface ExportedSymbol {
  name: string;
  kind: string;
  signature: string;
}

const extractor: ApiSurfaceExtractor = {
  key: 'npm-exports',
  title: 'npm Exports',
  async extract(context) {
    const packageFiles = await loadPackageJsonFiles(context);
    const entries: NpmExportEntry[] = [];

    for (const pkg of packageFiles) {
      const packageName = pkg.json.name ?? (pkg.dir || context.repo.fullName);
      const entrypoints = collectEntrypoints(pkg.json);
      if (entrypoints.length === 0) {
        entrypoints.push({ entrypoint: '.', path: './src/index.ts' });
      }

      for (const entrypoint of entrypoints) {
        const resolved = await resolveExistingEntryPath(context.readFile, pkg.dir, entrypoint.path);
        if (resolved === null) {
          continue;
        }
        const text = await context.readFile(resolved);
        entries.push({
          packageName,
          entrypoint: entrypoint.entrypoint,
          path: resolved,
          symbols: text === null ? [] : extractSymbols(text),
        });
      }
    }

    const bullets = entries.flatMap((entry) => {
      const header = `${code(entry.packageName)} ${code(entry.entrypoint)} -> ${code(entry.path)}`;
      if (entry.symbols.length === 0) {
        return [header];
      }
      return [
        header,
        ...entry.symbols.map(
          (symbol) => `  - ${code(symbol.kind)} ${code(symbol.name)}: ${code(symbol.signature)}`,
        ),
      ];
    });

    return { data: entries as unknown as JsonValue, markdown: renderBulletList(bullets) };
  },
};

export default extractor;

function collectEntrypoints(packageJson: {
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
}): { entrypoint: string; path: string }[] {
  const entries: { entrypoint: string; path: string }[] = [];
  collectExports(packageJson.exports, '.', entries);
  for (const [entrypoint, path] of [
    ['main', packageJson.main],
    ['module', packageJson.module],
    ['types', packageJson.types],
  ] as const) {
    if (typeof path === 'string') {
      entries.push({ entrypoint, path });
    }
  }
  return dedupeEntrypoints(entries);
}

function collectExports(
  value: unknown,
  entrypoint: string,
  entries: { entrypoint: string; path: string }[],
): void {
  if (typeof value === 'string') {
    entries.push({ entrypoint, path: value });
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return;
  }
  const object = value as Record<string, unknown>;
  const conditionPath = ['types', 'import', 'require', 'default']
    .map((key) => object[key])
    .find((candidate): candidate is string => typeof candidate === 'string');
  if (conditionPath !== undefined) {
    entries.push({ entrypoint, path: conditionPath });
    return;
  }
  for (const [key, nested] of Object.entries(object)) {
    if (key.startsWith('.')) {
      collectExports(nested, key, entries);
    }
  }
}

function dedupeEntrypoints(
  entries: readonly { entrypoint: string; path: string }[],
): { entrypoint: string; path: string }[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.entrypoint}\0${entry.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractSymbols(source: string): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    const declaration = trimmed.match(
      /^export\s+(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declaration?.[1] !== undefined && declaration[2] !== undefined) {
      symbols.push({ kind: declaration[1], name: declaration[2], signature: oneLine(trimmed) });
      continue;
    }
    const named = trimmed.match(/^export\s*\{([^}]+)\}/);
    if (named?.[1] === undefined) {
      continue;
    }
    for (const part of named[1].split(',')) {
      const [left, right] = part.trim().split(/\s+as\s+/);
      const name = (right ?? left)?.trim();
      if (name !== undefined && name.length > 0) {
        symbols.push({ kind: 'export', name, signature: oneLine(trimmed) });
      }
    }
  }
  return symbols;
}
