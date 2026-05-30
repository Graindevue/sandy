import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader, loadConfig } from './loader.js';

/**
 * Exercises the config loader end-to-end against real files on disk: a
 * `bot.yaml`, a defaults `agents/` directory, and an optional `.config/agents/`
 * override directory — all under temp dirs torn down after each test. Covers the
 * "resolve Product + Agent set for a PR's Repo" and "SIGHUP reload" criteria.
 */

function agentMd(name: string, extra = ''): string {
  return `---
name: ${name}
description: The ${name} agent.
vendor: claude
model: opus
maxIterations: 20
completionSignal: "</findings>"
tools: [read_file, rg]
${extra}---

# ${name} agent body
`;
}

const BOT_YAML = `
products:
  - slug: acme
    name: Acme
    repos:
      - owner: tony-co
        name: acme-backend
        defaultBranch: main
      - owner: tony-co
        name: acme-desktop
        defaultBranch: develop
    agents:
      - logic
  - slug: sandy
    name: Sandy
    repos:
      - owner: tony-co
        name: sandy
        defaultBranch: main
`;

interface Layout {
  configDir: string;
  botYamlPath: string;
  agentsDir: string;
  overridesDir: string;
}

let root: string;
let layout: Layout;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandy-loader-'));
  const configDir = join(root, '.config');
  const agentsDir = join(root, 'agents');
  const overridesDir = join(configDir, 'agents');
  await mkdir(configDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  layout = {
    configDir,
    botYamlPath: join(configDir, 'bot.yaml'),
    agentsDir,
    overridesDir,
  };
  await writeFile(layout.botYamlPath, BOT_YAML);
  await writeFile(join(agentsDir, 'logic.md'), agentMd('logic'));
  await writeFile(join(agentsDir, 'security.md'), agentMd('security', 'defaultEnabled: false\n'));
  await writeFile(join(agentsDir, 'convex.md'), agentMd('convex', 'defaultEnabled: auto\n'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function options() {
  return {
    botYamlPath: layout.botYamlPath,
    agentsDir: layout.agentsDir,
    overridesDir: layout.overridesDir,
  };
}

describe('loadConfig', () => {
  it('loads a valid bot.yaml and the Agent definitions', async () => {
    const config = await loadConfig(options());

    expect(config.products.map((p) => p.slug).sort()).toEqual(['acme', 'sandy']);
    expect([...config.agents.keys()].sort()).toEqual(['convex', 'logic', 'security']);
  });

  it('fails fast with a clear error on an invalid bot.yaml', async () => {
    await writeFile(layout.botYamlPath, 'products: []\n');

    await expect(loadConfig(options())).rejects.toThrow(/at least one product/i);
  });

  it('fails fast with a clear error when bot.yaml is missing', async () => {
    await rm(layout.botYamlPath);

    await expect(loadConfig(options())).rejects.toThrow(/bot\.yaml/i);
  });

  it('applies `.config/agents/` overrides by name', async () => {
    await mkdir(layout.overridesDir, { recursive: true });
    await writeFile(
      join(layout.overridesDir, 'logic.md'),
      agentMd('logic').replace('model: opus', 'model: haiku'),
    );

    const config = await loadConfig(options());

    expect(config.agents.get('logic')?.model).toBe('haiku');
  });

  it('rejects a bot.yaml that references an unknown Agent key', async () => {
    await writeFile(
      layout.botYamlPath,
      BOT_YAML.replace('      - logic', '      - logic\n      - nonesuch'),
    );

    await expect(loadConfig(options())).rejects.toThrow(/nonesuch/);
  });
});

describe('ConfigLoader.resolveForRepo', () => {
  it('resolves the correct Product and Agent set for a registered Repo', async () => {
    const loader = await ConfigLoader.create(options());

    const resolved = loader.resolveForRepo('tony-co', 'acme-backend');

    expect(resolved).not.toBeNull();
    expect(resolved?.product.slug).toBe('acme');
    expect(resolved?.repo.fullName).toBe('tony-co/acme-backend');
    expect(resolved?.repo.defaultBranch).toBe('main');
    // acme declares `agents: [logic]`, so exactly the logic Agent applies.
    expect(resolved?.agents.map((a) => a.key)).toEqual(['logic']);
  });

  it('resolves a sibling Repo to the same Product (cross-repo grouping)', async () => {
    const loader = await ConfigLoader.create(options());

    const resolved = loader.resolveForRepo('tony-co', 'acme-desktop');

    expect(resolved?.product.slug).toBe('acme');
    expect(resolved?.repo.defaultBranch).toBe('develop');
    expect(resolved?.agents.map((a) => a.key)).toEqual(['logic']);
  });

  it('falls back to the default Agent selection when a Product omits `agents`', async () => {
    const loader = await ConfigLoader.create(options());

    // The `sandy` Product declares no `agents`, so the default selection applies:
    // every Agent whose `defaultEnabled` is not false. `security` is opted out.
    const resolved = loader.resolveForRepo('tony-co', 'sandy');

    expect(resolved?.product.slug).toBe('sandy');
    expect(resolved?.agents.map((a) => a.key).sort()).toEqual(['convex', 'logic']);
  });

  it('is case-insensitive on owner/name', async () => {
    const loader = await ConfigLoader.create(options());

    const resolved = loader.resolveForRepo('Tony-Co', 'ACME-Backend');

    expect(resolved?.product.slug).toBe('acme');
  });

  it('returns null for an unregistered Repo', async () => {
    const loader = await ConfigLoader.create(options());

    expect(loader.resolveForRepo('someone', 'unknown')).toBeNull();
  });
});

describe('ConfigLoader.reload', () => {
  it('re-reads bot.yaml so a newly added Repo resolves without a restart', async () => {
    const loader = await ConfigLoader.create(options());
    expect(loader.resolveForRepo('tony-co', 'newly-added')).toBeNull();

    const updated = `${BOT_YAML}      - owner: tony-co\n        name: newly-added\n        defaultBranch: main\n`;
    await writeFile(layout.botYamlPath, updated);
    await loader.reload();

    const resolved = loader.resolveForRepo('tony-co', 'newly-added');
    expect(resolved?.product.slug).toBe('sandy');
  });

  it('keeps serving the prior config when a reload fails validation', async () => {
    const loader = await ConfigLoader.create(options());

    await writeFile(layout.botYamlPath, 'products: []\n');
    await expect(loader.reload()).rejects.toThrow(/at least one product/i);

    // The previous good config is still in effect after a failed reload.
    expect(loader.resolveForRepo('tony-co', 'acme-backend')?.product.slug).toBe('acme');
  });
});

describe('ConfigLoader SIGHUP', () => {
  it('reloads on SIGHUP and stops listening after dispose', async () => {
    const loader = await ConfigLoader.create(options());
    const reloadSpy = vi.spyOn(loader, 'reload');
    // A guard listener stays attached for the whole test so `process.emit`
    // always has a SIGHUP listener — the assertions watch the spy's call count,
    // never the loader being the only listener, and the guard is removed in the
    // `finally` so this test leaks no process-global listener.
    const guard = () => {};
    process.on('SIGHUP', guard);
    try {
      loader.installSignalHandler();
      process.emit('SIGHUP');
      // The handler invokes reload(); give the microtask queue a tick to run it.
      await Promise.resolve();
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      // After dispose the loader's handler is detached: a further SIGHUP no
      // longer reaches reload(), though the guard keeps SIGHUP handled.
      loader.dispose();
      process.emit('SIGHUP');
      await Promise.resolve();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      loader.dispose();
      process.removeListener('SIGHUP', guard);
    }
  });
});
