import { pathToFileURL } from 'node:url';
import type { AgentDefinition } from '@sandy/shared-types';
import { describe, expect, it } from 'vitest';
import {
  isMainModule,
  loadConfig,
  resolveConfiguredAgent,
  resolveConfiguredAgents,
  resolveReviewBotConfig,
} from './main.js';

describe('loadConfig PORT validation', () => {
  // Finding #8: PORT was parsed with Number.parseInt, which silently accepts
  // trailing garbage and scientific notation ('1e4' -> 1, '3007abc' -> 3007),
  // mis-binding the server despite the "fails loudly" contract. The whole string
  // must be a positive integer in [1, 65535].
  const baseEnv = {
    GITHUB_WEBHOOK_SECRET: 'secret',
    CONVEX_URL: 'https://example.convex.cloud',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY_PATH: '.config/key.pem',
  };

  it.each([
    '1e4',
    '3007abc',
    '',
    '0',
    '70000',
    ' 3007',
    '3007 ',
    '-1',
    '3.5',
    '0x10',
    'abc',
  ])('rejects PORT=%j', (port) => {
    expect(() => loadConfig({ ...baseEnv, PORT: port })).toThrow(/PORT/);
  });

  it('accepts a valid PORT', () => {
    expect(loadConfig({ ...baseEnv, PORT: '8080' }).port).toBe(8080);
  });

  it('accepts the boundary ports 1 and 65535', () => {
    expect(loadConfig({ ...baseEnv, PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...baseEnv, PORT: '65535' }).port).toBe(65535);
  });

  it('falls back to the default port when PORT is unset', () => {
    expect(loadConfig(baseEnv).port).toBe(3007);
  });
});

describe('loadConfig webhook secret', () => {
  // The GitHub App webhook secret is read from GITHUB_WEBHOOK_SECRET (the name the
  // operator stores in .config/.env per the setup docs), not a bare WEBHOOK_SECRET.
  it('reads the secret from GITHUB_WEBHOOK_SECRET', () => {
    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: 'shh',
      CONVEX_URL: 'https://example.convex.cloud',
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_PATH: '.config/key.pem',
    });
    expect(config.webhookSecret).toBe('shh');
  });

  it('throws naming GITHUB_WEBHOOK_SECRET when it is missing', () => {
    expect(() =>
      loadConfig({
        CONVEX_URL: 'https://example.convex.cloud',
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY_PATH: '.config/key.pem',
      }),
    ).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });
});

describe('loadConfig GitHub App credentials', () => {
  const baseEnv = {
    GITHUB_WEBHOOK_SECRET: 'secret',
    CONVEX_URL: 'https://example.convex.cloud',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY_PATH: '.config/key.pem',
  };

  it('requires GitHub App credentials for posting reviews and cloning private repos', () => {
    expect(() => loadConfig({ ...baseEnv, GITHUB_APP_ID: undefined })).toThrow(/GITHUB_APP_ID/);
    expect(() => loadConfig({ ...baseEnv, GITHUB_APP_PRIVATE_KEY_PATH: undefined })).toThrow(
      /GITHUB_APP_PRIVATE_KEY_PATH/,
    );
  });

  it('defaults the Finding embedder to the local Ollama host without an OpenAI key', () => {
    const config = loadConfig(baseEnv);

    expect(config.ollamaHost).toBe('http://127.0.0.1:11434');
    expect(config.agentEnv).toEqual({});
  });

  it('reads OLLAMA_HOST for Finding embeddings', () => {
    const config = loadConfig({
      ...baseEnv,
      OLLAMA_HOST: 'http://ollama.internal:11434',
    });

    expect(config.ollamaHost).toBe('http://ollama.internal:11434');
  });

  it('parses review execution options', () => {
    const config = loadConfig({
      ...baseEnv,
      SANDY_AGENT_IMAGE: 'custom-agent',
      SANDY_REVIEW_MAX_CHANGED_LINES: '123',
      SANDY_REVIEW_MAX_CONCURRENT_JOBS: '2',
      ANTHROPIC_API_KEY: 'sk-test',
      OPENAI_API_KEY: 'sk-openai',
    });

    expect(config.agentImage).toBe('custom-agent');
    expect(config.maxChangedLines).toBe(123);
    expect(config.maxConcurrentJobs).toBe(2);
    expect(config.agentEnv).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      OPENAI_API_KEY: 'sk-openai',
    });
  });
});

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
    );

    expect(config).toEqual({
      repoRules: '- Repo rule.',
      productRules: '- Product rule.',
      ignorePatterns: ['generated/**'],
    });
    expect(calls).toEqual([{ product, repo, options: { reviewRepoPath: '/tmp/worktree' } }]);
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

describe('isMainModule', () => {
  // Finding #1: the run-when-direct guard must encode the script path the same
  // way `import.meta.url` is encoded. A raw `file://${argv1}` concat fails on any
  // path with a space (or #, ?, %, non-ASCII), so `main()` never runs and the
  // worker boots without binding a port. Build the expected URL with
  // pathToFileURL — the source of truth Node uses for `import.meta.url`.
  it('matches when the script path contains a space', () => {
    const argv1 = '/Users/me/My Apps/sandy/dist/main.js';
    const importMetaUrl = pathToFileURL(argv1).href;
    // Encoded, so the space is %20 — a raw concat would not produce this.
    expect(importMetaUrl).toContain('%20');
    expect(isMainModule(importMetaUrl, argv1)).toBe(true);
  });

  it('matches for paths with other characters that require percent-encoding', () => {
    for (const argv1 of [
      '/srv/app#1/dist/main.js',
      '/srv/app?x/dist/main.js',
      '/srv/50%/dist/main.js',
      '/srv/café/dist/main.js',
    ]) {
      expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
    }
  });

  it('matches a plain ASCII path with no special characters', () => {
    const argv1 = '/srv/app/dist/main.js';
    expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
  });

  it('does not match when the module was imported (different path) or argv1 is absent', () => {
    const argv1 = '/srv/app/dist/main.js';
    expect(isMainModule(pathToFileURL('/srv/app/dist/other.js').href, argv1)).toBe(false);
    expect(isMainModule(pathToFileURL(argv1).href, undefined)).toBe(false);
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
      },
    ],
    agents: options.agents ?? [],
    agentSelectionMode: options.mode,
    agentOverrides: options.overrides ?? {},
  };
}
