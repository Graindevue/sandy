import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApiSurfaceExtractor } from '@sandy/shared-types';
import convexApi from './extractors/convex-api.js';
import convexSchema from './extractors/convex-schema.js';
import frameworkVersions from './extractors/framework-versions.js';
import httpRoutes from './extractors/http-routes.js';
import i18nKeys from './extractors/i18n-keys.js';
import npmExports from './extractors/npm-exports.js';

const BUILTIN_EXTRACTORS = [
  frameworkVersions,
  npmExports,
  convexApi,
  convexSchema,
  httpRoutes,
  i18nKeys,
] as const satisfies readonly ApiSurfaceExtractor[];

const IMPORTABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

export interface LoadExtractorsOptions {
  customExtractorsDir?: string;
  extractors?: readonly ApiSurfaceExtractor[];
}

export async function loadExtractors(
  options: LoadExtractorsOptions = {},
): Promise<ApiSurfaceExtractor[]> {
  if (options.extractors !== undefined) {
    return options.extractors.map((extractor) => assertExtractor(extractor));
  }

  const byKey = new Map<string, ApiSurfaceExtractor>();
  const order: string[] = [];
  for (const extractor of BUILTIN_EXTRACTORS) {
    byKey.set(extractor.key, extractor);
    order.push(extractor.key);
  }

  for (const extractor of await loadCustomExtractors(options.customExtractorsDir)) {
    if (!byKey.has(extractor.key)) {
      order.push(extractor.key);
    }
    byKey.set(extractor.key, extractor);
  }

  return order.map((key) => {
    const extractor = byKey.get(key);
    if (extractor === undefined) {
      throw new Error(`Extractor registry lost ${key}`);
    }
    return extractor;
  });
}

async function loadCustomExtractors(dir: string | undefined): Promise<ApiSurfaceExtractor[]> {
  if (dir === undefined || !(await isDirectory(dir))) {
    return [];
  }
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && IMPORTABLE_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => entry.name)
    .sort();

  const extractors: ApiSurfaceExtractor[] = [];
  for (const entry of entries) {
    const imported = await importExtractorModule(join(dir, entry));
    extractors.push(assertExtractor(imported.default, entry));
  }
  return extractors;
}

async function importExtractorModule(path: string): Promise<{ default?: unknown }> {
  const url = pathToFileURL(path).href;
  try {
    return (await import(url)) as { default?: unknown };
  } catch (error) {
    if (!isTypeScriptPath(path) || !isUnknownTypeScriptExtensionError(error)) {
      throw error;
    }
    const load = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<unknown>;
    const api = (await load('tsx/esm/api')) as {
      tsImport(specifier: string, parentURL: string): Promise<unknown>;
    };
    return (await api.tsImport(url, import.meta.url)) as { default?: unknown };
  }
}

function assertExtractor(value: unknown, source = 'extractor'): ApiSurfaceExtractor {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${source} must default-export an Extractor object`);
  }
  const candidate = value as Partial<ApiSurfaceExtractor>;
  if (typeof candidate.key !== 'string' || candidate.key.trim().length === 0) {
    throw new Error(`${source} Extractor must have a non-empty key`);
  }
  if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
    throw new Error(`${source} Extractor ${candidate.key} must have a non-empty title`);
  }
  if (typeof candidate.extract !== 'function') {
    throw new Error(`${source} Extractor ${candidate.key} must have an extract function`);
  }
  return candidate as ApiSurfaceExtractor;
}

function isTypeScriptPath(path: string): boolean {
  return ['.ts', '.mts', '.cts'].includes(extname(path));
}

function isUnknownTypeScriptExtensionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('code' in error ? (error as { code?: unknown }).code === 'ERR_UNKNOWN_FILE_EXTENSION' : true)
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}
