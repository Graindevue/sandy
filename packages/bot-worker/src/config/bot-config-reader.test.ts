import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotConfigReader } from './bot-config-reader.js';
import type { ProductConfig, RepoConfig } from './bot-yaml.js';

let root: string;

const repoA: RepoConfig = {
  owner: 'acme',
  name: 'api',
  fullName: 'acme/api',
  defaultBranch: 'main',
  excludeBranches: [],
};

const repoB: RepoConfig = {
  owner: 'acme',
  name: 'desktop',
  fullName: 'acme/desktop',
  defaultBranch: 'main',
  excludeBranches: [],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandy-bot-reader-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('BotConfigReader', () => {
  it('reads repo-local Rules, product Rules, agents.yaml, and ignore patterns', async () => {
    const apiRoot = join(root, 'api');
    const desktopRoot = join(root, 'desktop');
    await mkdir(join(apiRoot, '.bot'), { recursive: true });
    await mkdir(join(desktopRoot, '.bot'), { recursive: true });
    await writeFile(
      join(apiRoot, '.bot', 'rules.md'),
      '- Backend changes must preserve tenant isolation.\n',
    );
    await writeFile(
      join(desktopRoot, '.bot', 'rules.md'),
      '- Desktop changes must not block the renderer thread.\n',
    );
    await writeFile(
      join(apiRoot, '.bot', 'product-rules.md'),
      '- Schema changes use widen-migrate-narrow.\n- API errors expose stable codes.\n',
    );
    await writeFile(
      join(desktopRoot, '.bot', 'product-rules.md'),
      '- Schema changes use widen-migrate-narrow.\n- Product telemetry has opt-out coverage.\n',
    );
    await writeFile(join(apiRoot, '.bot', 'agents.yaml'), 'disable: [style]\n');
    await writeFile(
      join(apiRoot, '.bot', 'ignore.gitignore'),
      '# generated files\ngenerated/**\n*.snap\n',
    );

    const reader = new BotConfigReader({
      repoPath: (repo) => (repo.fullName === repoA.fullName ? apiRoot : desktopRoot),
    });

    const config = await reader.readReviewBotConfig(product([repoA, repoB]), repoA);

    expect(config.repoRules).toBe('- Backend changes must preserve tenant isolation.');
    expect(config.productRules).toBe(
      [
        '- Schema changes use widen-migrate-narrow.',
        '- API errors expose stable codes.',
        '- Product telemetry has opt-out coverage.',
      ].join('\n'),
    );
    expect(config.ignorePatterns).toEqual(['generated/**', '*.snap']);
    expect(config.repos.find((repo) => repo.repo.fullName === repoA.fullName)?.agentsYaml).toBe(
      'disable: [style]',
    );
  });

  it('applies only the reviewed Repo-local Rules while sharing Product Rules', async () => {
    const apiRoot = join(root, 'api');
    const desktopRoot = join(root, 'desktop');
    await mkdir(join(apiRoot, '.bot'), { recursive: true });
    await mkdir(join(desktopRoot, '.bot'), { recursive: true });
    await writeFile(join(apiRoot, '.bot', 'rules.md'), '- API-only rule.\n');
    await writeFile(join(desktopRoot, '.bot', 'rules.md'), '- Desktop-only rule.\n');
    await writeFile(join(apiRoot, '.bot', 'product-rules.md'), '- Shared product rule.\n');

    const reader = new BotConfigReader({
      repoPath: (repo) => (repo.fullName === repoA.fullName ? apiRoot : desktopRoot),
    });

    const apiConfig = await reader.readReviewBotConfig(product([repoA, repoB]), repoA);
    const desktopConfig = await reader.readReviewBotConfig(product([repoA, repoB]), repoB);

    expect(apiConfig.repoRules).toBe('- API-only rule.');
    expect(apiConfig.repoRules).not.toContain('Desktop-only');
    expect(desktopConfig.repoRules).toBe('- Desktop-only rule.');
    expect(desktopConfig.productRules).toBe('- Shared product rule.');
  });

  it('returns empty config for a Repo with no .bot directory', async () => {
    const apiRoot = join(root, 'api');
    await mkdir(apiRoot, { recursive: true });
    const reader = new BotConfigReader({ repoPath: () => apiRoot });

    const config = await reader.readReviewBotConfig(product([repoA]), repoA);

    expect(config.repoRules).toBeNull();
    expect(config.productRules).toBeNull();
    expect(config.ignorePatterns).toEqual([]);
    expect(config.repos[0]?.agentsYaml).toBeNull();
  });

  it('can read the reviewed Repo .bot files from a PR worktree override', async () => {
    const defaultRoot = join(root, 'default-api');
    const worktreeRoot = join(root, 'worktree-api');
    await mkdir(join(defaultRoot, '.bot'), { recursive: true });
    await mkdir(join(worktreeRoot, '.bot'), { recursive: true });
    await writeFile(join(defaultRoot, '.bot', 'rules.md'), '- Default-branch rule.\n');
    await writeFile(join(worktreeRoot, '.bot', 'rules.md'), '- PR-head rule.\n');

    const reader = new BotConfigReader({ repoPath: () => defaultRoot });

    const config = await reader.readReviewBotConfig(product([repoA]), repoA, {
      reviewRepoPath: worktreeRoot,
    });

    expect(config.repoRules).toBe('- PR-head rule.');
  });
});

function product(repos: RepoConfig[]): ProductConfig {
  return {
    slug: 'acme',
    name: 'Acme',
    repos,
    agents: [],
    agentSelectionMode: 'default',
    agentOverrides: {},
  };
}
