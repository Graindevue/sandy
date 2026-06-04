import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBotConfig } from './bot-yaml.js';

/**
 * Validates the `.config/bot.yaml` parser against the documented schema
 * (`docs/setup/bot-yaml.md`): Products, the Repos they contain, and an optional
 * per-Product Agent selection and runtime overrides. A valid document parses
 * into a normalized shape; every invalid one throws a message that names what is
 * wrong.
 */

const MINIMAL = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
`;

const FULL = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
      - owner: tony-co
        name: acme-desktop
        defaultBranch: main
    agents:
      - logic
  - slug: sandy
    name: Sandy
    repos:
      - owner: tony-co
        name: sandy
        defaultBranch: main
`;

describe('parseBotConfig', () => {
  it('parses a minimal config into one Product with one Repo', () => {
    const config = parseBotConfig(MINIMAL);

    expect(config.products).toHaveLength(1);
    const product = config.products[0];
    expect(product?.slug).toBe('acme');
    expect(product?.name).toBe('Acme');
    expect(product?.repos).toHaveLength(1);
    expect(product?.repos[0]?.owner).toBe('tony-co');
    expect(product?.repos[0]?.name).toBe('acme-backend');
    expect(product?.repos[0]?.defaultBranch).toBe('main');
    expect(product?.repos[0]?.excludeBranches).toEqual([]);
    // `fullName` is derived, not authored.
    expect(product?.repos[0]?.fullName).toBe('tony-co/acme-backend');
    // No `agents:` => default/auto selection and no runtime overrides.
    expect(product?.agents).toEqual([]);
    expect(product?.agentSelectionMode).toBe('default');
    expect(product?.agentOverrides).toEqual({});
  });

  it('parses per-Repo base-branch exclusion patterns', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
        excludeBranches:
          - " release/* "
          - vendor/**
`;

    const repo = parseBotConfig(yaml).products[0]?.repos[0];

    expect(repo?.excludeBranches).toEqual(['release/*', 'vendor/**']);
  });

  it('parses a full multi-Product config and preserves list-form exact Agent selection', () => {
    const config = parseBotConfig(FULL);

    expect(config.products).toHaveLength(2);
    const acme = config.products.find((p) => p.slug === 'acme');
    expect(acme?.repos.map((r) => r.fullName)).toEqual([
      'tony-co/acme-backend',
      'tony-co/acme-desktop',
    ]);
    expect(acme?.agents).toEqual(['logic']);
    expect(acme?.agentSelectionMode).toBe('explicit');
    expect(acme?.agentOverrides).toEqual({});
    const sandy = config.products.find((p) => p.slug === 'sandy');
    expect(sandy?.repos).toHaveLength(1);
    expect(sandy?.agentSelectionMode).toBe('default');
  });

  it('parses object-form exact selection and runtime overrides', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents:
      enable: [logic, security]
      overrides:
        logic:
          vendor: codex
          model: gpt-5.6
        security:
          vendor: claude
          model: opus
`;

    const product = parseBotConfig(yaml).products[0];

    expect(product?.agents).toEqual(['logic', 'security']);
    expect(product?.agentSelectionMode).toBe('explicit');
    expect(product?.agentOverrides).toEqual({
      logic: { vendor: 'codex', model: 'gpt-5.6' },
      security: { vendor: 'claude', model: 'opus' },
    });
  });

  it('allows object-form runtime overrides without exact selection', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents:
      overrides:
        logic:
          vendor: codex
          model: gpt-5.6
`;

    const product = parseBotConfig(yaml).products[0];

    expect(product?.agents).toEqual([]);
    expect(product?.agentSelectionMode).toBe('default');
    expect(product?.agentOverrides).toEqual({ logic: { vendor: 'codex', model: 'gpt-5.6' } });
  });

  it('treats an empty object-form agents mapping as default selection', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents: {}
`;

    const product = parseBotConfig(yaml).products[0];

    expect(product?.agents).toEqual([]);
    expect(product?.agentSelectionMode).toBe('default');
    expect(product?.agentOverrides).toEqual({});
  });

  it('allows empty runtime overrides as a no-op', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents:
      overrides: {}
`;

    const product = parseBotConfig(yaml).products[0];

    expect(product?.agentSelectionMode).toBe('default');
    expect(product?.agentOverrides).toEqual({});
  });

  it('throws on YAML that is not a mapping', () => {
    expect(() => parseBotConfig('- just\n- a\n- list\n')).toThrow(/mapping/i);
  });

  it('throws on invalid YAML syntax', () => {
    expect(() => parseBotConfig('products: [oops: : :')).toThrow(/bot\.yaml/i);
  });

  it('throws when `products` is missing', () => {
    expect(() => parseBotConfig('name: nope\n')).toThrow(/products/);
  });

  it('throws when `products` is empty', () => {
    expect(() => parseBotConfig('products: []\n')).toThrow(/at least one product/i);
  });

  it('throws when a Product is missing `slug`, naming the index', () => {
    const yaml = `
products:
  - name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
`;
    expect(() => parseBotConfig(yaml)).toThrow(/products\[0\]/);
    expect(() => parseBotConfig(yaml)).toThrow(/slug/);
  });

  it('throws when a Product has no repos', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos: []
`;
    expect(() => parseBotConfig(yaml)).toThrow(/acme/);
    expect(() => parseBotConfig(yaml)).toThrow(/at least one repo/i);
  });

  it('throws when a Repo is missing `defaultBranch`, naming the path', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
`;
    expect(() => parseBotConfig(yaml)).toThrow(/acme/);
    expect(() => parseBotConfig(yaml)).toThrow(/defaultBranch/);
  });

  it('throws when `excludeBranches` is not a list', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
        excludeBranches: release/*
`;
    expect(() => parseBotConfig(yaml)).toThrow(
      /products\[0\] \(acme\)\.repos\[0\]\.excludeBranches/,
    );
    expect(() => parseBotConfig(yaml)).toThrow(/list/);
  });

  it('throws when an `excludeBranches` entry is not a string, naming the index', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
        excludeBranches:
          - release/*
          - 123
`;
    expect(() => parseBotConfig(yaml)).toThrow(
      /products\[0\] \(acme\)\.repos\[0\]\.excludeBranches\[1\]/,
    );
  });

  it('throws when an `excludeBranches` entry is empty after trimming', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
        excludeBranches:
          - release/*
          - "   "
`;
    expect(() => parseBotConfig(yaml)).toThrow(
      /products\[0\] \(acme\)\.repos\[0\]\.excludeBranches\[1\]/,
    );
    expect(() => parseBotConfig(yaml)).toThrow(/non-empty string/);
  });

  it('throws on a duplicate Product slug', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: a
        defaultBranch: main
  - slug: acme
    name: Acme Two
    repos:
      - owner: tony-co
        name: b
        defaultBranch: main
`;
    expect(() => parseBotConfig(yaml)).toThrow(/duplicate/i);
    expect(() => parseBotConfig(yaml)).toThrow(/acme/);
  });

  it('throws when the same Repo appears under two Products', () => {
    const yaml = `
products:
  - slug: one
    name: One
    repos:
      - owner: tony-co
        name: shared
        defaultBranch: main
  - slug: two
    name: Two
    repos:
      - owner: tony-co
        name: shared
        defaultBranch: main
`;
    expect(() => parseBotConfig(yaml)).toThrow(/tony-co\/shared/);
  });

  it('treats Repos that differ only in case as the same (case-insensitive dedup)', () => {
    // GitHub slugs are case-insensitive and the loader's index lowercases them,
    // so these must collide here rather than silently overwriting in the index.
    const yaml = `
products:
  - slug: one
    name: One
    repos:
      - owner: Tony-Co
        name: Shared
        defaultBranch: main
  - slug: two
    name: Two
    repos:
      - owner: tony-co
        name: shared
        defaultBranch: main
`;
    expect(() => parseBotConfig(yaml)).toThrow(/declared under both/i);
  });

  it('trims surrounding whitespace from Repo fields', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: "  tony-co  "
        name: "  acme-backend  "
        defaultBranch: "  main  "
`;
    const repo = parseBotConfig(yaml).products[0]?.repos[0];
    expect(repo?.owner).toBe('tony-co');
    expect(repo?.name).toBe('acme-backend');
    expect(repo?.defaultBranch).toBe('main');
    expect(repo?.fullName).toBe('tony-co/acme-backend');
  });

  it('throws when list-form `agents` is not a list of strings', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents:
      - 123
`;
    expect(() => parseBotConfig(yaml)).toThrow(/agents/);
  });

  it('throws when object-form `agents.enable` is not a list of strings', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents:
      enable: [logic, 123]
`;
    expect(() => parseBotConfig(yaml)).toThrow(/agents\.enable/);
  });

  it('throws when a runtime override omits vendor or model', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents:
      overrides:
        logic:
          model: gpt-5.6
`;
    expect(() => parseBotConfig(yaml)).toThrow(/vendor/);
  });

  it('throws when a runtime override uses an unsupported vendor', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents:
      overrides:
        logic:
          vendor: palm
          model: unknown
`;
    expect(() => parseBotConfig(yaml)).toThrow(/vendor/);
  });

  it('throws when object-form `agents` contains unsupported keys', () => {
    const yaml = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
    agents:
      disable: [style]
`;
    expect(() => parseBotConfig(yaml)).toThrow(/disable/);
  });

  it('throws on an empty document', () => {
    expect(() => parseBotConfig('')).toThrow(/empty/i);
  });

  it('accepts the committed .config/bot.example.yaml', () => {
    // packages/bot-worker/src/config/ -> repo root is four levels up.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const example = readFileSync(join(repoRoot, '.config', 'bot.example.yaml'), 'utf8');

    const config = parseBotConfig(example);

    expect(config.products.map((p) => p.slug)).toEqual(['acme', 'sandy']);
    expect(config.products[0]?.repos[0]?.fullName).toBe('your-org/acme-backend');
  });
});
