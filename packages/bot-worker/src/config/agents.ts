import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentDefaultEnabled, AgentDefinition, AgentVendor } from '@sandy/shared-types';
import { parse as parseYaml } from 'yaml';
import { parseEffort } from './effort.js';

/**
 * Loads Agent definitions from markdown files and surfaces them keyed by Agent
 * key (the file name without `.md`). Defaults ship in `agents/`; a per-instance
 * `.config/agents/` directory overlays them — same file name overrides by key,
 * a new file name adds an Agent (ADR 0006). Each file is YAML frontmatter (the
 * metadata) plus a markdown body (the system prompt).
 */

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const VENDORS: readonly AgentVendor[] = ['claude', 'codex', 'cursor', 'copilot'];

/** The shape of an Agent file's parsed YAML frontmatter, before validation. */
interface RawFrontmatter {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  vendor?: unknown;
  model?: unknown;
  effort?: unknown;
  tools?: unknown;
  maxIterations?: unknown;
  completionSignal?: unknown;
  defaultEnabled?: unknown;
}

/**
 * Read and parse every `agents/*.md` file under `defaultsDir`, then overlay the
 * optional `overridesDir` (`.config/agents/`). Returns a `Map` from Agent key to
 * its {@link AgentDefinition}. Override semantics: a file in `overridesDir` whose
 * name matches a default replaces it by key; a new name adds an Agent.
 *
 * Throws — with the offending file named — when `defaultsDir` is missing or any
 * file has malformed/incomplete frontmatter, so a misconfigured instance fails
 * fast at startup rather than running a partial Agent set.
 */
export async function loadAgentDefinitions(
  defaultsDir: string,
  overridesDir?: string,
): Promise<Map<string, AgentDefinition>> {
  const agents = new Map<string, AgentDefinition>();

  // Defaults must exist — they ship with Sandy.
  for (const path of await listMarkdownFiles(defaultsDir, { required: true })) {
    const definition = parseAgentFile(path, await readFile(path, 'utf8'));
    agents.set(definition.key, definition);
  }

  // The override directory is optional: a fresh instance need not have one.
  if (overridesDir !== undefined) {
    for (const path of await listMarkdownFiles(overridesDir, { required: false })) {
      const definition = parseAgentFile(path, await readFile(path, 'utf8'));
      agents.set(definition.key, definition);
    }
  }

  return agents;
}

/**
 * List the absolute paths of the `*.md` files directly in `dir`, sorted by name
 * for deterministic loading. A missing `required` directory throws a clear
 * error; a missing optional directory yields an empty list (the instance simply
 * has no overrides). The Agent key is derived later, in {@link parseAgentFile},
 * so it has a single source of truth.
 */
async function listMarkdownFiles(
  dir: string,
  { required }: { required: boolean },
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (!required && isNotFound(error)) {
      return [];
    }
    throw new Error(`agent directory ${dir} could not be read: ${describeError(error)}`);
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Parse one Agent file into an {@link AgentDefinition}. The Agent key is derived
 * from the file name (not the frontmatter `name`) so the override-by-file-name
 * rule holds. Validation errors name the file so the operator can find it.
 */
export function parseAgentFile(path: string, contents: string): AgentDefinition {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (match === null) {
    throw new Error(`agent file ${path} is missing YAML frontmatter (a leading \`---\` block)`);
  }
  const [, frontmatterText, body] = match;

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterText ?? '');
  } catch (error) {
    throw new Error(`agent file ${path} has invalid YAML frontmatter: ${describeError(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`agent file ${path} frontmatter must be a YAML mapping`);
  }
  const fm = parsed as RawFrontmatter;

  // Strip `.md` case-insensitively to match the case-insensitive directory
  // filter, so a `.config/agents/` override replaces a default by key regardless
  // of extension case (ADR 0006's override-by-file-name rule).
  const key = basename(path).replace(/\.md$/i, '');

  const vendor = requireVendor(fm.vendor, path);
  // `effort` is vendor-scoped, so it validates against the vendor parsed above.
  const effort = parseEffort(fm.effort, vendor, `agent file ${path}: \`effort\``);

  return {
    key,
    name: requireString(fm.name, 'name', path),
    description: requireString(fm.description, 'description', path),
    category: optionalString(fm.category, 'category', path) ?? key,
    vendor,
    model: requireString(fm.model, 'model', path),
    ...(effort !== undefined ? { effort } : {}),
    ...(fm.tools !== undefined ? { tools: requireStringArray(fm.tools, 'tools', path) } : {}),
    ...(fm.maxIterations !== undefined
      ? { maxIterations: requirePositiveInt(fm.maxIterations, 'maxIterations', path) }
      : {}),
    completionSignal: requireString(fm.completionSignal, 'completionSignal', path),
    defaultEnabled: parseDefaultEnabled(fm.defaultEnabled, path),
    systemPrompt: (body ?? '').trim(),
  };
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`agent file ${path}: \`${field}\` is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field, path);
}

function requireVendor(value: unknown, path: string): AgentVendor {
  if (typeof value !== 'string' || !VENDORS.includes(value as AgentVendor)) {
    throw new Error(
      `agent file ${path}: \`vendor\` must be one of ${VENDORS.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as AgentVendor;
}

function requireStringArray(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`agent file ${path}: \`${field}\` must be a list of strings`);
  }
  return value as string[];
}

function requirePositiveInt(value: unknown, field: string, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`agent file ${path}: \`${field}\` must be a positive integer`);
  }
  return value;
}

/**
 * Parse the optional `defaultEnabled` frontmatter field. Absent => `true` (a
 * shipped Agent runs unless told otherwise). Accepts a boolean or the literal
 * string `'auto'`.
 */
function parseDefaultEnabled(value: unknown, path: string): AgentDefaultEnabled {
  if (value === undefined) {
    return true;
  }
  if (typeof value === 'boolean' || value === 'auto') {
    return value;
  }
  throw new Error(
    `agent file ${path}: \`defaultEnabled\` must be true, false, or "auto", got ${JSON.stringify(value)}`,
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
