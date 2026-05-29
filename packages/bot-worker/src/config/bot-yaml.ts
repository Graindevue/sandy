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
}

/** A Product as declared in `bot.yaml`. */
export interface ProductConfig {
  slug: string;
  name: string;
  /** One or more Repos; guaranteed non-empty after validation. */
  repos: RepoConfig[];
  /** Agent keys to run for this Product; empty when the file omits `agents`. */
  agents: string[];
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

  return { slug, name, repos, agents: parseAgents(product.agents, `${where}.agents`) };
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
  const fullName = `${owner}/${name}`;

  const existingOwner = seenRepos.get(fullName);
  if (existingOwner !== undefined) {
    throw new Error(
      `bot.yaml: repo ${fullName} is declared under both product ${JSON.stringify(existingOwner)} and ${JSON.stringify(productSlug)}; a Repo belongs to exactly one Product`,
    );
  }
  seenRepos.set(fullName, productSlug);

  return { owner, name, fullName, defaultBranch };
}

function parseAgents(value: unknown, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`bot.yaml: ${where} must be a list of Agent-key strings`);
  }
  return value as string[];
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`bot.yaml: ${where} is required and must be a non-empty string`);
  }
  return value;
}
