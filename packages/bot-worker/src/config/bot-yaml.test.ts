import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBotConfig } from './bot-yaml.js';

/**
 * Validates the `.config/bot.yaml` parser against the documented schema
 * (`docs/setup/bot-yaml.md`): Products, the Repos they contain, and an optional
 * per-Product Agent selection. A valid document parses into a normalized shape;
 * every invalid one throws a message that names what is wrong.
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
    // `fullName` is derived, not authored.
    expect(product?.repos[0]?.fullName).toBe('tony-co/acme-backend');
    // No `agents:` => empty list (caller applies default selection).
    expect(product?.agents).toEqual([]);
  });

  it('parses a full multi-Product config and preserves the Agent selection', () => {
    const config = parseBotConfig(FULL);

    expect(config.products).toHaveLength(2);
    const acme = config.products.find((p) => p.slug === 'acme');
    expect(acme?.repos.map((r) => r.fullName)).toEqual([
      'tony-co/acme-backend',
      'tony-co/acme-desktop',
    ]);
    expect(acme?.agents).toEqual(['logic']);
    const sandy = config.products.find((p) => p.slug === 'sandy');
    expect(sandy?.repos).toHaveLength(1);
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

  it('throws when `agents` is not a list of strings', () => {
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
