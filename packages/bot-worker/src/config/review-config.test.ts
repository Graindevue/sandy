import type { AgentDefinition } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import {
  resolveConfiguredAgent,
  resolveConfiguredAgents,
  resolveReviewBotConfig,
} from './review-config.js';

describe('resolveConfiguredAgent', () => {
  it('returns only Agents that apply to the repo', () => {
    const logicAgent = agent('logic');
    const securityAgent = agent('security');
    const loader = {
      resolveForRepo: () => ({
        agents: [logicAgent],
      }),
    };

    expect(
      resolveConfiguredAgent(
        loader,
        { owner: 'acme', name: 'widget', defaultBranch: 'main' },
        'logic',
      ),
    ).toBe(logicAgent);
    expect(
      resolveConfiguredAgent(
        loader,
        { owner: 'acme', name: 'widget', defaultBranch: 'main' },
        securityAgent.key,
      ),
    ).toBeNull();
  });

  it('returns null when the repo is not registered', () => {
    const loader = {
      resolveForRepo: () => null,
    };

    expect(
      resolveConfiguredAgent(
        loader,
        { owner: 'acme', name: 'unknown', defaultBranch: 'main' },
        'logic',
      ),
    ).toBeNull();
  });
});

describe('resolveConfiguredAgents', () => {
  it('returns all loaded Agents for a Product using default selection', () => {
    const logicAgent = agent('logic');
    const styleAgent = { ...agent('style'), defaultEnabled: false as const };
    const loader = {
      config: {
        agents: new Map([
          [logicAgent.key, logicAgent],
          [styleAgent.key, styleAgent],
        ]),
      },
      resolveForRepo: () => ({
        product: product({ mode: 'default' }),
        agents: [logicAgent],
      }),
    };

    expect(
      resolveConfiguredAgents(loader, { owner: 'acme', name: 'widget', defaultBranch: 'main' }).map(
        (resolvedAgent) => resolvedAgent.key,
      ),
    ).toEqual(['logic', 'style']);
  });

  it('applies Product runtime overrides to default-selection candidates without mutating loaded Agents', () => {
    const logicAgent = agent('logic');
    const loader = {
      config: {
        agents: new Map([[logicAgent.key, logicAgent]]),
      },
      resolveForRepo: () => ({
        product: product({
          mode: 'default',
          overrides: { logic: { vendor: 'codex', model: 'gpt-5.6' } },
        }),
        agents: [logicAgent],
      }),
    };

    const [resolved] = resolveConfiguredAgents(loader, {
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    });

    expect(resolved).toMatchObject({ key: 'logic', vendor: 'codex', model: 'gpt-5.6' });
    expect(resolved).not.toBe(logicAgent);
    expect(logicAgent).toMatchObject({ vendor: 'claude', model: 'opus' });
  });

  it('treats Product-explicit Agents as enabled selection candidates', () => {
    const styleAgent = { ...agent('style'), defaultEnabled: false as const };
    const loader = {
      config: {
        agents: new Map([[styleAgent.key, styleAgent]]),
      },
      resolveForRepo: () => ({
        product: product({ mode: 'explicit', agents: ['style'] }),
        agents: [styleAgent],
      }),
    };

    const [resolved] = resolveConfiguredAgents(loader, {
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    });

    expect(resolved?.key).toBe('style');
    expect(resolved?.defaultEnabled).toBe(true);
  });

  it('applies Product runtime overrides to Product-explicit candidates', () => {
    const logicAgent = agent('logic');
    const securityAgent = agent('security');
    const loader = {
      config: {
        agents: new Map([
          [logicAgent.key, logicAgent],
          [securityAgent.key, securityAgent],
        ]),
      },
      resolveForRepo: () => ({
        product: product({
          mode: 'explicit',
          agents: ['logic'],
          overrides: {
            logic: { vendor: 'codex', model: 'gpt-5.6' },
            security: { vendor: 'claude', model: 'sonnet' },
          },
        }),
        agents: [logicAgent],
      }),
    };

    const resolved = resolveConfiguredAgents(loader, {
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    });

    expect(resolved).toEqual([
      expect.objectContaining({
        key: 'logic',
        vendor: 'codex',
        model: 'gpt-5.6',
        defaultEnabled: true,
      }),
    ]);
  });
});

describe('resolveReviewBotConfig', () => {
  it('reads .bot context for the configured Product and reviewed Repo', async () => {
    const repo = {
      owner: 'acme',
      name: 'widget',
      fullName: 'acme/widget',
      defaultBranch: 'main',
      excludeBranches: [],
    };
    const product = {
      slug: 'acme',
      name: 'Acme',
      repos: [repo],
      agents: [],
      agentSelectionMode: 'default' as const,
      agentOverrides: {},
    };
    const calls: unknown[] = [];

    const config = await resolveReviewBotConfig(
      {
        resolveForRepo: () => ({ product, repo }),
      },
      {
        async readReviewBotConfig(productArg, repoArg, options) {
          calls.push({ product: productArg, repo: repoArg, options });
          return {
            repoRules: '- Repo rule.',
            productRules: '- Product rule.',
            ignorePatterns: ['generated/**'],
          };
        },
      },
      { owner: 'acme', name: 'widget', defaultBranch: 'main' },
      '/tmp/worktree',
      '1234567890123456789012345678901234567890',
    );

    expect(config).toEqual({
      repoRules: '- Repo rule.',
      productRules: '- Product rule.',
      ignorePatterns: ['generated/**'],
    });
    expect(calls).toEqual([
      {
        product,
        repo,
        options: {
          reviewRepoPath: '/tmp/worktree',
          reviewRepoSha: '1234567890123456789012345678901234567890',
        },
      },
    ]);
  });

  it('returns empty .bot context for an unregistered Repo', async () => {
    const config = await resolveReviewBotConfig(
      {
        resolveForRepo: () => null,
      },
      {
        async readReviewBotConfig() {
          throw new Error('should not read .bot files');
        },
      },
      { owner: 'acme', name: 'unknown', defaultBranch: 'main' },
    );

    expect(config).toEqual({ repoRules: null, productRules: null, ignorePatterns: [] });
  });
});

function agent(key: string): AgentDefinition {
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
    defaultEnabled: true,
    systemPrompt: `# ${key}`,
  };
}

function product(options: {
  mode: 'default' | 'explicit';
  agents?: string[];
  overrides?: Record<string, { vendor: 'claude' | 'codex' | 'cursor' | 'copilot'; model: string }>;
}) {
  return {
    slug: 'acme',
    name: 'Acme',
    repos: [
      {
        owner: 'acme',
        name: 'widget',
        fullName: 'acme/widget',
        defaultBranch: 'main',
        excludeBranches: [],
      },
    ],
    agents: options.agents ?? [],
    agentSelectionMode: options.mode,
    agentOverrides: options.overrides ?? {},
  };
}
