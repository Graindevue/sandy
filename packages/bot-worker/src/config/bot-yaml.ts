import type { AgentVendor } from '@sandy/shared-types';
import { parse as parseYaml } from 'yaml';

/**
 * Parses and validates `.config/bot.yaml` — the declaration of which Products
 * Sandy reviews and the Repos each contains (CONTEXT.md; schema in
 * `docs/setup/bot-yaml.md`). The parsed shape is config-only: it carries the
 * fields authored in the file plus a derived `fullName`, not the Convex document
 * ids that `Product`/`Repo` gain at runtime.
 *
 * Every validation failure throws an `Error` whose message names the offending
 * path (e.g. `products[0].repos[1]`) so a misconfigured instance fails fast with
 * an actionable message rather than booting with a silently-wrong config.
 */

/** A Repo as declared in `bot.yaml`, with `fullName` derived from owner/name. */
export interface RepoConfig {
  owner: string;
  name: string;
  /** Derived `"owner/name"`; not authored in the file. */
  fullName: string;
  defaultBranch: string;
  /** Glob patterns for base branches that should not auto-arm reviews. */
  excludeBranches: string[];
}

export type AgentSelectionMode = 'default' | 'explicit';

export interface AgentRuntimeOverride {
  vendor: AgentVendor;
  model: string;
}

/** A Product as declared in `bot.yaml`. */
export interface ProductConfig {
  slug: string;
  name: string;
  /** One or more Repos; guaranteed non-empty after validation. */
  repos: RepoConfig[];
  /** Exact Agent keys to run when `agentSelectionMode === 'explicit'`. */
  agents: string[];
  /** Whether `agents` is an exact Product set or default/auto selection applies. */
  agentSelectionMode: AgentSelectionMode;
  /** Product-scoped runtime overrides keyed by Agent key. */
  agentOverrides: Record<string, AgentRuntimeOverride>;
}

/** The validated contents of `bot.yaml`. */
export interface BotConfig {
  /** Declared Products; guaranteed non-empty after validation. */
  products: ProductConfig[];
}

interface RawRepo {
  owner?: unknown;
  name?: unknown;
  defaultBranch?: unknown;
  excludeBranches?: unknown;
}

interface RawProduct {
  slug?: unknown;
  name?: unknown;
  repos?: unknown;
  agents?: unknown;
}

interface RawConfig {
  products?: unknown;
}

const AGENT_VENDORS: readonly AgentVendor[] = ['claude', 'codex', 'cursor', 'copilot'];

/**
 * Parse the raw text of `bot.yaml` into a validated {@link BotConfig}. Throws on
 * malformed YAML, a missing or empty `products` list, missing required fields,
 * duplicate Product slugs, or a Repo declared under more than one Product.
 */
export function parseBotConfig(contents: string): BotConfig {
  if (contents.trim().length === 0) {
    throw new Error('bot.yaml is empty: declare at least one product');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`bot.yaml is not valid YAML: ${detail}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('bot.yaml must be a YAML mapping with a top-level `products` list');
  }

  const raw = parsed as RawConfig;
  if (!Array.isArray(raw.products)) {
    throw new Error('bot.yaml: `products` is required and must be a list');
  }
  if (raw.products.length === 0) {
    throw new Error('bot.yaml: `products` must contain at least one product');
  }

  const seenSlugs = new Set<string>();
  const seenRepos = new Map<string, string>();
  const products = raw.products.map((rawProduct, index) =>
    parseProduct(rawProduct, index, seenSlugs, seenRepos),
  );

  return { products };
}

function parseProduct(
  rawProduct: unknown,
  index: number,
  seenSlugs: Set<string>,
  seenRepos: Map<string, string>,
): ProductConfig {
  const where = `products[${index}]`;
  if (typeof rawProduct !== 'object' || rawProduct === null || Array.isArray(rawProduct)) {
    throw new Error(`bot.yaml: ${where} must be a mapping`);
  }
  const product = rawProduct as RawProduct;

  const slug = requireString(product.slug, `${where}.slug`);
  if (seenSlugs.has(slug)) {
    throw new Error(`bot.yaml: duplicate product slug ${JSON.stringify(slug)} at ${where}`);
  }
  seenSlugs.add(slug);

  const name = requireString(product.name, `${where}.name`);

  if (!Array.isArray(product.repos)) {
    throw new Error(`bot.yaml: ${where}.repos is required and must be a list`);
  }
  if (product.repos.length === 0) {
    throw new Error(`bot.yaml: ${where} (${slug}) must declare at least one repo`);
  }
  const repos = product.repos.map((rawRepo, repoIndex) =>
    // The slug is woven into the path so a Repo-field error points the operator
    // at the right Product, not just an opaque numeric index.
    parseRepo(rawRepo, `${where} (${slug}).repos[${repoIndex}]`, slug, seenRepos),
  );

  const agents = parseAgents(product.agents, `${where}.agents`);

  return { slug, name, repos, ...agents };
}

function parseRepo(
  rawRepo: unknown,
  where: string,
  productSlug: string,
  seenRepos: Map<string, string>,
): RepoConfig {
  if (typeof rawRepo !== 'object' || rawRepo === null || Array.isArray(rawRepo)) {
    throw new Error(`bot.yaml: ${where} must be a mapping`);
  }
  const repo = rawRepo as RawRepo;

  const owner = requireString(repo.owner, `${where}.owner`);
  const name = requireString(repo.name, `${where}.name`);
  const defaultBranch = requireString(repo.defaultBranch, `${where}.defaultBranch`);
  const excludeBranches = parseOptionalStringList(repo.excludeBranches, `${where}.excludeBranches`);
  const fullName = `${owner}/${name}`;

  // Dedup on a case-insensitive key to match the loader's index, which lowercases
  // owner/name (GitHub slugs are case-insensitive). Two repos differing only in
  // case would otherwise pass this check and then collide in the index, where one
  // silently overwrites the other and gets misrouted to the wrong Product.
  const dedupKey = fullName.toLowerCase();
  const existingOwner = seenRepos.get(dedupKey);
  if (existingOwner !== undefined) {
    throw new Error(
      `bot.yaml: repo ${fullName} is declared under both product ${JSON.stringify(existingOwner)} and ${JSON.stringify(productSlug)}; a Repo belongs to exactly one Product`,
    );
  }
  seenRepos.set(dedupKey, productSlug);

  return { owner, name, fullName, defaultBranch, excludeBranches };
}

function parseAgents(
  value: unknown,
  where: string,
): {
  agents: string[];
  agentSelectionMode: AgentSelectionMode;
  agentOverrides: Record<string, AgentRuntimeOverride>;
} {
  if (value === undefined) {
    return { agents: [], agentSelectionMode: 'default', agentOverrides: {} };
  }
  if (Array.isArray(value)) {
    return {
      agents: parseAgentKeyList(value, where),
      // Preserve today's behavior: an empty list behaves like omitting `agents`.
      agentSelectionMode: value.length === 0 ? 'default' : 'explicit',
      agentOverrides: {},
    };
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`bot.yaml: ${where} must be either a list of Agent-key strings or a mapping`);
  }

  const object = value as Record<string, unknown>;
  assertKnownKeys(object, ['enable', 'overrides'], where);

  const hasEnable = Object.hasOwn(object, 'enable');
  return {
    agents: hasEnable ? parseAgentKeyList(object.enable, `${where}.enable`) : [],
    agentSelectionMode: hasEnable ? 'explicit' : 'default',
    agentOverrides: parseAgentRuntimeOverrides(object.overrides, `${where}.overrides`),
  };
}

function parseAgentKeyList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`bot.yaml: ${where} must be a list of Agent-key strings`);
  }
  return value as string[];
}

function parseOptionalStringList(value: unknown, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`bot.yaml: ${where} must be a list of non-empty strings`);
  }
  return value.map((item, index) => requireString(item, `${where}[${index}]`));
}

function parseAgentRuntimeOverrides(
  value: unknown,
  where: string,
): Record<string, AgentRuntimeOverride> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`bot.yaml: ${where} must be a mapping of Agent keys to runtime overrides`);
  }

  const overrides: Record<string, AgentRuntimeOverride> = {};
  for (const [key, rawOverride] of Object.entries(value)) {
    if (key.trim().length === 0 || key !== key.trim()) {
      throw new Error(`bot.yaml: ${where} contains an invalid Agent key ${JSON.stringify(key)}`);
    }
    overrides[key] = parseAgentRuntimeOverride(rawOverride, `${where}.${key}`);
  }
  return overrides;
}

function parseAgentRuntimeOverride(value: unknown, where: string): AgentRuntimeOverride {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`bot.yaml: ${where} must be a mapping with vendor and model`);
  }
  const object = value as Record<string, unknown>;
  assertKnownKeys(object, ['vendor', 'model'], where);
  return {
    vendor: requireVendor(object.vendor, `${where}.vendor`),
    model: requireString(object.model, `${where}.model`),
  };
}

function requireVendor(value: unknown, where: string): AgentVendor {
  if (typeof value !== 'string' || !AGENT_VENDORS.includes(value as AgentVendor)) {
    throw new Error(
      `bot.yaml: ${where} must be one of ${AGENT_VENDORS.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as AgentVendor;
}

function assertKnownKeys(
  object: Record<string, unknown>,
  allowedKeys: readonly string[],
  where: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(
        `bot.yaml: ${where}.${key} is not supported (allowed: ${allowedKeys.join(', ')})`,
      );
    }
  }
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`bot.yaml: ${where} is required and must be a non-empty string`);
  }
  // Return the trimmed value: surrounding whitespace would otherwise flow into
  // `fullName`, the repo index key, and `git clone --branch <value>`, breaking
  // matching and cloning.
  return value.trim();
}
