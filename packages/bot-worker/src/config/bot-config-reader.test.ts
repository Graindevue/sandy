import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureGit } from '../../../../test-support/git.js';
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

    await commitRepo(apiRoot);
    await commitRepo(desktopRoot);
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

    await commitRepo(apiRoot);
    await commitRepo(desktopRoot);
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
    await commitRepo(apiRoot);
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
    await commitRepo(defaultRoot);
    await commitRepo(worktreeRoot);

    const reader = new BotConfigReader({ repoPath: () => defaultRoot });

    const config = await reader.readReviewBotConfig(product([repoA]), repoA, {
      reviewRepoPath: worktreeRoot,
    });

    expect(config.repoRules).toBe('- PR-head rule.');
  });

  it.each(['rules.md', 'product-rules.md', 'agents.yaml', 'ignore.gitignore'])(
    'rejects %s symlinks that would read outside the repository',
    async (filename) => {
      const apiRoot = join(root, 'api');
      await mkdir(join(apiRoot, '.bot'), { recursive: true });
      const outsideFile = join(root, 'credential.txt');
      await writeFile(outsideFile, 'DUMMY_PRIVATE_CONTENT');
      await symlink(outsideFile, join(apiRoot, '.bot', filename));
      await commitRepo(apiRoot);
      const reader = new BotConfigReader({ repoPath: () => apiRoot });

      await expect(reader.readReviewBotConfig(product([repoA]), repoA)).rejects.toThrow(
        'outside the repository',
      );
    },
  );

  it('rejects a .bot directory symlink escaping the repository', async () => {
    const apiRoot = join(root, 'api');
    const outsideDir = join(root, 'private');
    await mkdir(apiRoot);
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'rules.md'), 'DUMMY_PRIVATE_CONTENT');
    await symlink(outsideDir, join(apiRoot, '.bot'));
    await commitRepo(apiRoot);
    const reader = new BotConfigReader({ repoPath: () => apiRoot });

    await expect(reader.readReviewBotConfig(product([repoA]), repoA)).rejects.toThrow(
      'outside the repository',
    );
  });

  it('reads regular-file symlinks whose targets stay within the repository', async () => {
    const apiRoot = join(root, 'api');
    await mkdir(join(apiRoot, '.bot'), { recursive: true });
    await writeFile(join(apiRoot, 'shared-rules.md'), '- Verify the actual call site.');
    await symlink('../shared-rules.md', join(apiRoot, '.bot', 'rules.md'));
    await commitRepo(apiRoot);
    const reader = new BotConfigReader({ repoPath: () => apiRoot });

    const config = await reader.readReviewBotConfig(product([repoA]), repoA);

    expect(config.repoRules).toBe('- Verify the actual call site.');
  });

  it('rejects non-file .bot entries before attempting to read their contents', async () => {
    const apiRoot = join(root, 'api');
    await mkdir(join(apiRoot, '.bot', 'rules.md'), { recursive: true });
    await writeFile(join(apiRoot, '.bot', 'rules.md', 'entry'), 'not a rules file');
    await commitRepo(apiRoot);
    const reader = new BotConfigReader({ repoPath: () => apiRoot });

    await expect(reader.readReviewBotConfig(product([repoA]), repoA)).rejects.toThrow(
      'must be a regular file',
    );
  });

  it('pins rules to the requested PR commit despite HEAD changes and replaced .bot ancestors', async () => {
    const apiRoot = join(root, 'api');
    const outside = join(root, 'private');
    await mkdir(join(apiRoot, '.bot'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(apiRoot, '.bot', 'rules.md'), '- Pinned PR rule.');
    const sha = await commitRepo(apiRoot);
    await writeFile(join(apiRoot, '.bot', 'rules.md'), '- Later commit rule.');
    await commitRepo(apiRoot);
    await writeFile(join(outside, 'rules.md'), 'DUMMY_OUTSIDE_HOST_CONTENT');
    await rename(join(apiRoot, '.bot'), join(apiRoot, 'original-bot'));
    await symlink(outside, join(apiRoot, '.bot'));
    const reader = new BotConfigReader({ repoPath: () => apiRoot });

    const config = await reader.readReviewBotConfig(product([repoA]), repoA, {
      reviewRepoPath: apiRoot,
      reviewRepoSha: sha,
    });

    expect(config.repoRules).toBe('- Pinned PR rule.');
  });

  it('reads every Product Repo rule from its pinned workspace source', async () => {
    const apiRoot = join(root, 'api');
    const desktopRoot = join(root, 'desktop');
    await mkdir(join(apiRoot, '.bot'), { recursive: true });
    await mkdir(join(desktopRoot, '.bot'), { recursive: true });
    await writeFile(join(apiRoot, '.bot', 'rules.md'), '- Reviewed PR rule.');
    await writeFile(join(desktopRoot, '.bot', 'product-rules.md'), '- Pinned sibling rule.');
    const apiSha = await commitRepo(apiRoot);
    const desktopSha = await commitRepo(desktopRoot);
    await writeFile(join(desktopRoot, '.bot', 'product-rules.md'), '- Later sibling rule.');
    await commitRepo(desktopRoot);
    const reader = new BotConfigReader({
      repoPath: () => {
        throw new Error('Must use pinned workspace sources');
      },
    });

    const config = await reader.readReviewBotConfig(product([repoA, repoB]), repoA, {
      repoSources: [
        { fullName: repoA.fullName, worktreePath: apiRoot, sha: apiSha },
        { fullName: repoB.fullName, worktreePath: desktopRoot, sha: desktopSha },
      ],
    });

    expect(config.repoRules).toBe('- Reviewed PR rule.');
    expect(config.productRules).toBe('- Pinned sibling rule.');
    await expect(
      reader.readReviewBotConfig(product([repoA, repoB]), repoA, {
        repoSources: [{ fullName: repoA.fullName, worktreePath: apiRoot, sha: apiSha }],
      }),
    ).rejects.toThrow('Pinned source is missing for acme/desktop');
  });
});

async function commitRepo(repoRoot: string): Promise<string> {
  await fixtureGit(['init', '-q', repoRoot]);
  await fixtureGit(['-C', repoRoot, 'add', '.']);
  await fixtureGit(['-C', repoRoot, 'commit', '-q', '--allow-empty', '-m', 'Fixture']);
  const { stdout } = await fixtureGit(['-C', repoRoot, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

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
