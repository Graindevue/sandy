import { readFile } from 'node:fs/promises';
import type { AgentDefinition } from '@sandy/shared-types';
import { loadAgentDefinitions } from './agents.js';
import { type BotConfig, type ProductConfig, parseBotConfig, type RepoConfig } from './bot-yaml.js';

/**
 * The config layer: turns declared configuration on disk into a resolved view a
 * Review can act on — "for this PR's Repo, which Product and which Agent(s)
 * apply" (CONTEXT.md). Reads `.config/bot.yaml` (Products + Repos) and the Agent
 * definitions from `agents/` overlaid by `.config/agents/` (ADR 0006), and
 * supports SIGHUP-driven reload without a process restart (Phase 1 PRD).
 */

/** Where the config layer reads from. All paths are absolute. */
export interface ConfigLoaderOptions {
  /** Path to `.config/bot.yaml`. */
  botYamlPath: string;
  /** Directory of default Agent definitions (`agents/`). */
  agentsDir: string;
  /** Optional per-instance override directory (`.config/agents/`). */
  overridesDir?: string;
}

/** A loaded, cross-validated config: the parsed Products plus all Agents. */
export interface LoadedConfig {
  products: ProductConfig[];
  /** Every known Agent, keyed by Agent key. */
  agents: Map<string, AgentDefinition>;
}

/** The resolved review context for a PR on a registered Repo. */
export interface ResolvedRepo {
  /** The Product the Repo belongs to. */
  product: ProductConfig;
  /** The specific Repo within that Product. */
  repo: RepoConfig;
  /** The Agents that apply to this Product, already resolved from keys. */
  agents: AgentDefinition[];
}

/**
 * Load and validate the full config: parse `bot.yaml`, load Agent definitions,
 * then cross-check that every Agent key a Product references actually exists.
 * Throws — naming the offending file/field — on any failure so a bad config is
 * caught at startup, not mid-Review.
 */
export async function loadConfig(options: ConfigLoaderOptions): Promise<LoadedConfig> {
  const botConfig = await readBotConfig(options.botYamlPath);
  const agents = await loadAgentDefinitions(options.agentsDir, options.overridesDir);
  assertAgentKeysExist(botConfig, agents);
  return { products: botConfig.products, agents };
}

async function readBotConfig(path: string): Promise<BotConfig> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`bot.yaml could not be read at ${path}: ${detail}`);
  }
  return parseBotConfig(contents);
}

/**
 * Fail fast if a Product references an Agent key that no Agent file defines — a
 * typo there would otherwise silently drop an Agent from every Review of that
 * Product.
 */
function assertAgentKeysExist(config: BotConfig, agents: Map<string, AgentDefinition>): void {
  for (const product of config.products) {
    for (const key of product.agents) {
      if (!agents.has(key)) {
        const known = [...agents.keys()].sort().join(', ');
        throw new Error(
          `bot.yaml: product ${JSON.stringify(product.slug)} references unknown Agent ${JSON.stringify(key)} (known: ${known || 'none'})`,
        );
      }
    }
  }
}

/**
 * Resolve which Agents apply to a Product. An explicit `agents` list selects
 * exactly those (already validated to exist); an empty list falls back to the
 * default selection — every Agent whose `defaultEnabled` is not `false`.
 * (`'auto'` Agents are included; per-Product auto-detection is a later phase.)
 */
function resolveAgents(
  product: ProductConfig,
  agents: Map<string, AgentDefinition>,
): AgentDefinition[] {
  if (product.agents.length > 0) {
    return product.agents.map((key) => {
      const agent = agents.get(key);
      if (agent === undefined) {
        // Unreachable: loadConfig cross-validates keys. Guarded for type safety.
        throw new Error(`unknown Agent key ${JSON.stringify(key)}`);
      }
      return agent;
    });
  }
  return [...agents.values()].filter((agent) => agent.defaultEnabled !== false);
}

/**
 * Holds the live config and answers Repo → (Product, Agents) lookups. Built once
 * at startup via {@link ConfigLoader.create}; {@link reload} re-reads from disk
 * (SIGHUP) and atomically swaps the in-memory view, keeping the prior config in
 * effect if the new one fails validation.
 */
export class ConfigLoader {
  #config: LoadedConfig;
  #index: Map<string, ResolvedRepo>;
  readonly #options: ConfigLoaderOptions;
  #sighupHandler: (() => void) | null = null;

  private constructor(options: ConfigLoaderOptions, config: LoadedConfig) {
    this.#options = options;
    this.#config = config;
    this.#index = buildIndex(config);
  }

  /** Load the config from disk and build a ready-to-query loader. */
  static async create(options: ConfigLoaderOptions): Promise<ConfigLoader> {
    const config = await loadConfig(options);
    return new ConfigLoader(options, config);
  }

  /** The currently-loaded config (Products + Agents). */
  get config(): LoadedConfig {
    return this.#config;
  }

  /**
   * Resolve the Product, Repo, and applicable Agents for a registered Repo by
   * `owner`/`name` (case-insensitive). Returns `null` when the Repo is not
   * declared in `bot.yaml` — the caller declines to review unregistered Repos.
   */
  resolveForRepo(owner: string, name: string): ResolvedRepo | null {
    return this.#index.get(repoKey(owner, name)) ?? null;
  }

  /**
   * Re-read the config from disk and atomically swap it in. On a validation
   * failure the error propagates and the previously-loaded config stays in
   * effect, so a fat-fingered edit cannot take the worker's config down.
   */
  async reload(): Promise<void> {
    const config = await loadConfig(this.#options);
    this.#config = config;
    this.#index = buildIndex(config);
  }

  /**
   * Install a `SIGHUP` handler that reloads the config (Phase 1 PRD: SIGHUP
   * triggers reload; no automatic file-watch in v1). A failed reload is logged
   * and swallowed so an invalid edit does not crash the worker — the prior
   * config keeps serving. Idempotent: a second call replaces the handler.
   */
  installSignalHandler(): void {
    this.dispose();
    const handler = () => {
      this.reload().catch((error) => {
        console.error('SIGHUP config reload failed; keeping previous config', error);
      });
    };
    this.#sighupHandler = handler;
    process.on('SIGHUP', handler);
  }

  /** Detach the SIGHUP handler. Safe to call when none is installed. */
  dispose(): void {
    if (this.#sighupHandler !== null) {
      process.removeListener('SIGHUP', this.#sighupHandler);
      this.#sighupHandler = null;
    }
  }
}

/** Build the owner/name → ResolvedRepo lookup, keyed lowercase for matching. */
function buildIndex(config: LoadedConfig): Map<string, ResolvedRepo> {
  const index = new Map<string, ResolvedRepo>();
  for (const product of config.products) {
    const agents = resolveAgents(product, config.agents);
    for (const repo of product.repos) {
      index.set(repoKey(repo.owner, repo.name), { product, repo, agents });
    }
  }
  return index;
}

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}
