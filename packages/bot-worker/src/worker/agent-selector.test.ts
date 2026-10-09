import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentDefinition } from '@sandy/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectAgentsForReview } from './agent-selector.js';

let root: string;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandy-agent-selector-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('selectAgentsForReview', () => {
  it.each([
    { paths: ['apps/web/page.tsx'], expected: ['logic'] },
    { paths: ['packages/backend/convex/bookings.ts'], expected: ['logic', 'convex'] },
  ])('runs the Convex Agent only when its backend is changed: $paths', async ({
    paths,
    expected,
  }) => {
    const selected = await selectAgentsForReview({
      agents: [agent('logic', true), agent('convex', true)],
      reviewRepoFullName: 'acme/api',
      productRepos: [],
      changedPaths: paths,
    });
    expect(selected.map((entry) => entry.key)).toEqual(expected);
  });
  it('honors defaultEnabled, Product-wide framework auto-detection, and reviewed Repo overrides', async () => {
    const apiRoot = join(root, 'api');
    const webRoot = join(root, 'web');
    await writePackageJson(apiRoot, {
      dependencies: { next: '^15.0.0', 'next-intl': '^3.0.0' },
    });
    await writePackageJson(webRoot, {
      dependencies: { convex: '^1.0.0' },
    });

    const selected = await selectAgentsForReview({
      agents: [
        agent('logic', true),
        agent('security', true),
        agent('style', false),
        agent('test-coverage', true),
        agent('convex', 'auto'),
        agent('nextjs', 'auto'),
        agent('i18n', 'auto'),
      ],
      reviewRepoFullName: 'acme/api',
      productRepos: [
        {
          fullName: 'acme/api',
          worktreePath: apiRoot,
          agentsYaml: 'enable: [style]\ndisable: [security]\n',
        },
        { fullName: 'acme/web', worktreePath: webRoot, agentsYaml: null },
      ],
    });

    expect(selected.map((selectedAgent) => selectedAgent.key)).toEqual([
      'logic',
      'style',
      'test-coverage',
      'convex',
      'nextjs',
      'i18n',
    ]);
  });

  it('does not auto-enable convex when no Product Repo declares a convex dependency', async () => {
    const apiRoot = join(root, 'api');
    const webRoot = join(root, 'web');
    await writePackageJson(apiRoot, { dependencies: { next: '^15.0.0' } });
    await writePackageJson(webRoot, { devDependencies: { vitest: '^4.0.0' } });

    const selected = await selectAgentsForReview({
      agents: [agent('logic', true), agent('convex', 'auto'), agent('nextjs', 'auto')],
      reviewRepoFullName: 'acme/api',
      productRepos: [
        { fullName: 'acme/api', worktreePath: apiRoot, agentsYaml: null },
        { fullName: 'acme/web', worktreePath: webRoot, agentsYaml: null },
      ],
    });

    expect(selected.map((selectedAgent) => selectedAgent.key)).toEqual(['logic', 'nextjs']);
  });

  it('does not inspect package.json when no Agent needs auto-detection', async () => {
    const apiRoot = join(root, 'api');
    await mkdir(apiRoot, { recursive: true });
    await writeFile(join(apiRoot, 'package.json'), '{');

    const selected = await selectAgentsForReview({
      agents: [agent('logic', true), agent('style', false)],
      reviewRepoFullName: 'acme/api',
      productRepos: [{ fullName: 'acme/api', worktreePath: apiRoot, agentsYaml: null }],
    });

    expect(selected.map((selectedAgent) => selectedAgent.key)).toEqual(['logic']);
  });
});

async function writePackageJson(
  repoRoot: string,
  packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, 'package.json'), JSON.stringify(packageJson, null, 2));
  await execFileAsync('git', ['init', '-q', repoRoot]);
  await execFileAsync('git', ['-C', repoRoot, 'add', '.']);
  await execFileAsync('git', [
    '-C',
    repoRoot,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'Fixture',
  ]);
}

function agent(key: string, defaultEnabled: AgentDefinition['defaultEnabled']): AgentDefinition {
  return {
    key,
    name: key,
    description: `${key} agent`,
    category: key,
    vendor: 'claude',
    model: 'opus',
    tools: [],
    maxIterations: 1,
    completionSignal: '</findings>',
    defaultEnabled,
    systemPrompt: `# ${key}`,
  };
}

import { execFile } from 'node:child_process';
