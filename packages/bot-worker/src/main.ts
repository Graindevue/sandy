import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { api } from '@sandy/convex-backend/api';
import type { AgentDefinition } from '@sandy/shared-types';
import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { BotConfigReader } from './config/bot-config-reader.js';
import type { ProductConfig, RepoConfig } from './config/bot-yaml.js';
import { applyProductRuntimeOverride, ConfigLoader } from './config/loader.js';
import {
  defaultCloneBaseDir,
  defaultConfigLoaderOptions,
  defaultCustomExtractorsDir,
} from './config/paths.js';
import { EMPTY_REVIEW_BOT_CONTEXT, type ReviewBotContext } from './config/review-bot-context.js';
import { CloneManager } from './git/clone-manager.js';
import { GitHubAppClient } from './github/app-client.js';
import {
  disabledArchetypeAssigner,
  FindingArchetypeAssigner,
} from './learning/archetype-assigner.js';
import { DEFAULT_OLLAMA_HOST, OllamaFindingEmbedder } from './learning/embed.js';
import {
  inferPrMergeStateSignals,
  startMergeStateSignalCron,
} from './learning/merge-state-inferrer.js';
import { provisionOllamaEmbeddingBackend } from './learning/ollama-provisioner.js';
import { PromotionWorker } from './learning/promotion-worker.js';
import { capturePrCloseReactions as captureCloseReactions } from './learning/reaction-capture.js';
import { captureCommentReply as captureReplyFeedback } from './learning/reply-handler.js';
import { startWebhookServer } from './webhook/server.js';
import { ConvexSink } from './webhook/sink.js';
import { ReviewCancellationCoordinator } from './worker/cancellation.js';
import { ReviewClaimant } from './worker/claimant.js';
import { ConvexExecutionStore } from './worker/execution-store.js';
import { PullRequestPoster } from './worker/poster.js';
import { type RepoForWorktree, ReviewExecutor } from './worker/review-executor.js';
import { SANDY_WORKER_CONTAINER_PREFIX, SandcastleRunner } from './worker/sandcastle-runner.js';

/** Resolved worker configuration, read once from the environment at startup. */
export interface WorkerConfig {
  webhookSecret: string;
  convexUrl: string;
  githubAppId: string;
  githubPrivateKeyPath: string;
  ollamaHost: string;
  port: number;
  agentImage: string;
  maxChangedLines: number;
  maxConcurrentJobs: number;
  agentEnv: Record<string, string>;
}

const DEFAULT_PORT = 3007;
const DEFAULT_AGENT_IMAGE = 'sandy-agent';
const DEFAULT_MAX_CHANGED_LINES = 5000;
const DEFAULT_MAX_CONCURRENT_JOBS = 1;
const AGENT_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
const APPLE_CONTAINER_PROVIDER_PACKAGE = '@sandy/apple-container-provider';

type AppleContainerProviderModule = {
  cleanupOrphanedAppleContainers: (options: { namePrefix: string }) => Promise<{
    found: string[];
    deleted: string[];
    failed: readonly { name: string; error: string }[];
  }>;
};

/**
 * Read and validate the worker's configuration from `env`. Throws with a clear
 * message if a required variable is missing or `PORT` is not a valid port, so a
 * misconfigured deploy fails loudly at boot rather than silently mis-routing.
 */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const webhookSecret = requireEnv(env, 'GITHUB_WEBHOOK_SECRET');
  const convexUrl = requireEnv(env, 'CONVEX_URL');
  const githubAppId = requireEnv(env, 'GITHUB_APP_ID');
  const githubPrivateKeyPath = requireEnv(env, 'GITHUB_APP_PRIVATE_KEY_PATH');
  const ollamaHost = parseOllamaHost(env.OLLAMA_HOST);
  const port = env.PORT === undefined ? DEFAULT_PORT : parsePort(env.PORT);
  const maxChangedLines =
    env.SANDY_REVIEW_MAX_CHANGED_LINES === undefined
      ? DEFAULT_MAX_CHANGED_LINES
      : parsePositiveInt(env.SANDY_REVIEW_MAX_CHANGED_LINES, 'SANDY_REVIEW_MAX_CHANGED_LINES');
  const maxConcurrentJobs =
    env.SANDY_REVIEW_MAX_CONCURRENT_JOBS === undefined
      ? DEFAULT_MAX_CONCURRENT_JOBS
      : parsePositiveInt(env.SANDY_REVIEW_MAX_CONCURRENT_JOBS, 'SANDY_REVIEW_MAX_CONCURRENT_JOBS');

  return {
    webhookSecret,
    convexUrl,
    githubAppId,
    githubPrivateKeyPath,
    ollamaHost,
    port,
    agentImage: parseAgentImage(env.SANDY_AGENT_IMAGE),
    maxChangedLines,
    maxConcurrentJobs,
    agentEnv: pickAgentEnv(env),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * Parse a `PORT` string into a TCP port in `[1, 65535]`. The whole string must be
 * decimal digits: `Number.parseInt` would silently accept trailing garbage and
 * misread scientific notation (`'1e4'` → 1, `'3007abc'` → 3007), mis-binding the
 * server instead of failing loudly. Throws on anything else.
 */
function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`PORT must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`PORT must be in the range 1-65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function parsePositiveInt(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (value < 1) {
    throw new Error(`${name} must be greater than 0, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseAgentImage(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_AGENT_IMAGE;
  }

  const trimmed = raw.trim();
  return trimmed.length === 0 ? DEFAULT_AGENT_IMAGE : trimmed;
}

function parseOllamaHost(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_OLLAMA_HOST;
  }

  const trimmed = raw.trim();
  return trimmed.length === 0 ? DEFAULT_OLLAMA_HOST : trimmed;
}

function pickAgentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of AGENT_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}

/** Worker entry point: start the webhook front door and the ReviewJob execution loop. */
export async function main(): Promise<void> {
  loadInstanceEnv(process.cwd(), process.env);
  const config = loadConfig(process.env);
  await cleanupWorkerAppleContainers();
  const httpClient = new ConvexHttpClient(config.convexUrl);
  const reactiveClient = new ConvexClient(config.convexUrl);
  const sink = new ConvexSink(httpClient);
  const repoRoot = process.cwd();
  const configLoader = await ConfigLoader.create(defaultConfigLoaderOptions(repoRoot));
  configLoader.installSignalHandler();
  await syncConfiguredProducts(httpClient, configLoader);
  const github = new GitHubAppClient({
    appId: config.githubAppId,
    privateKey: await readPrivateKey(repoRoot, config.githubPrivateKeyPath),
  });
  startMergeStateSignalCron({ store: sink, github, logger: console });
  const cloneManager = new CloneManager({
    baseDir: defaultCloneBaseDir(process.env),
    cloneUrl: (repo) => github.cloneUrlForRepo(repo),
  });
  const botConfigReader = new BotConfigReader({
    repoPath: async (repo) => {
      await cloneManager.ensureCloned(repo);
      return cloneManager.repoPath(repo);
    },
  });
  const cancellations = new ReviewCancellationCoordinator();
  const poster = new PullRequestPoster(github);
  const executionStore = new ConvexExecutionStore(reactiveClient);
  const ollama = await provisionOllamaEmbeddingBackend({
    host: config.ollamaHost,
    logger: console,
  });
  const archetypeAssigner = ollama.ready
    ? new FindingArchetypeAssigner(
        new OllamaFindingEmbedder({ host: ollama.host, model: ollama.model }),
        executionStore,
      )
    : disabledArchetypeAssigner;
  const executor = new ReviewExecutor({
    store: executionStore,
    cloneManager,
    diffInspector: github,
    runner: new SandcastleRunner({ imageName: config.agentImage, env: config.agentEnv }),
    poster,
    archetypeAssigner,
    cancellationRegistry: cancellations,
    maxChangedLines: config.maxChangedLines,
    manifestBuilder: {
      buildManifest: async (productId, repoShas) => {
        const { buildManifest } = await import('@sandy/manifest-builder');
        return await buildManifest(productId, repoShas, {
          customExtractorsDir: defaultCustomExtractorsDir(repoRoot),
        });
      },
    },
    resolveAgent: (repo, agentKey) => resolveConfiguredAgent(configLoader, repo, agentKey),
    resolveAgents: (repo) => resolveConfiguredAgents(configLoader, repo),
    resolveReviewBotConfig: ({ repo, worktreePath }) =>
      resolveReviewBotConfig(configLoader, botConfigReader, repo, worktreePath),
  });
  const claimant = new ReviewClaimant({
    client: reactiveClient,
    handleClaimedJob: (jobId) => executor.executeClaimedJob(jobId),
    maxConcurrentJobs: config.maxConcurrentJobs,
  });
  claimant.start();
  new PromotionWorker({
    client: reactiveClient,
    github,
    reviewSink: sink,
    resolveAgentKeys: (repo) =>
      resolveConfiguredAgents(configLoader, {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      }).map((agent) => agent.key),
  }).start();

  await startWebhookServer(config.port, {
    webhookSecret: config.webhookSecret,
    sink,
    pullRequestResolver: github,
    reviewCanceller: cancellations,
    // Enqueue each Review with the Repo's configured candidate Agents (bot.yaml),
    // not a hardcoded Agent. Unregistered Repos resolve to none. The worker refines
    // this set at worktree time via selectAgentsForReview.
    resolveAgentKeys: (repo) =>
      configLoader.resolveForRepo(repo.owner, repo.name)?.agents.map((agent) => agent.key) ?? [],
    forkDeclineCommenter: {
      async postForkDeclined({ repo, pullNumber, body }) {
        await github.createIssueComment({
          owner: repo.owner,
          repo: repo.name,
          issueNumber: pullNumber,
          body,
        });
      },
    },
    closeSignalCapturer: {
      async capturePrCloseSignals({ repo, pullNumber, pullRequestId, state }) {
        const closeReactions = await captureCloseReactions({
          repo,
          pullNumber,
          pullRequestId,
          store: sink,
          github,
        });
        if (state !== 'merged') {
          return closeReactions;
        }

        const mergeState = await inferPrMergeStateSignals({
          repo,
          pullNumber,
          pullRequestId,
          store: sink,
          github,
        });
        await sink.markMergeStateSignalsRolledUp({ pullRequestId, rolledUpAt: Date.now() });
        return { recorded: closeReactions.recorded + mergeState.recorded };
      },
    },
    replyCapturer: {
      async captureCommentReply({ repo, pullNumber, pullRequestId, comment }) {
        return await captureReplyFeedback({
          repo,
          pullNumber,
          pullRequestId,
          comment,
          store: sink,
          github,
        });
      },
    },
  });
  console.info(`Sandy webhook server listening on :${config.port}`);
}

/**
 * Reconcile the Products and Repos declared in `.config/bot.yaml` into Convex at
 * startup so the executor's per-Review context (read from the Convex `repos`
 * table) includes every sibling Repo. Without this, a Repo added to the config is
 * registered only when a webhook for it first arrives — and only as its own
 * single-Repo Product — so cross-repo Reviews would not see it.
 */
async function syncConfiguredProducts(
  client: ConvexHttpClient,
  configLoader: ConfigLoader,
): Promise<void> {
  const { products } = configLoader.config;
  for (const product of products) {
    await client.mutation(api.products.syncProduct, {
      slug: product.slug,
      name: product.name,
      repos: product.repos.map((repo) => ({
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
      })),
    });
  }
  console.info(`Synced ${products.length} Product(s) from bot.yaml to Convex`);
}

async function cleanupWorkerAppleContainers(): Promise<void> {
  try {
    const { cleanupOrphanedAppleContainers } = await importAppleContainerProvider();
    const result = await cleanupOrphanedAppleContainers({
      namePrefix: SANDY_WORKER_CONTAINER_PREFIX,
    });
    if (result.deleted.length > 0) {
      console.info(`Cleaned up ${result.deleted.length} orphaned Sandy worker container(s)`);
    }
    for (const failure of result.failed) {
      console.warn(
        `Failed to clean up orphaned Sandy worker container ${failure.name}: ${failure.error}`,
      );
    }
  } catch (error) {
    console.warn(`Skipping Sandy worker container startup cleanup: ${errorMessage(error)}`);
  }
}

async function importAppleContainerProvider(): Promise<AppleContainerProviderModule> {
  return (await import(APPLE_CONTAINER_PROVIDER_PACKAGE)) as AppleContainerProviderModule;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadInstanceEnv(repoRoot: string, env: NodeJS.ProcessEnv): void {
  const envPath = join(repoRoot, '.config', '.env');
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const equals = trimmed.indexOf('=');
    if (equals === -1) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    const value = unquoteEnvValue(trimmed.slice(equals + 1).trim());
    if (key.length > 0 && env[key] === undefined) {
      env[key] = value;
    }
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readPrivateKey(repoRoot: string, privateKeyPath: string): Promise<string> {
  return readFile(resolve(repoRoot, privateKeyPath), 'utf8');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Whether this module is the process entry point (`node dist/main.js`) rather
 * than an import (e.g. from tests). `import.meta.url` is a percent-encoded
 * `file://` URL, so the script path must be encoded the same way via
 * {@link pathToFileURL} — a raw `` `file://${argv1}` `` concat fails to match on
 * any install path containing a space, `#`, `?`, `%`, or non-ASCII character,
 * which would silently skip {@link main} and boot a worker that binds no port.
 */
export function isMainModule(importMetaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  return importMetaUrl === pathToFileURL(argv1).href;
}

interface ConfiguredAgentLoader {
  resolveForRepo(
    owner: string,
    name: string,
  ): {
    agents: AgentDefinition[];
  } | null;
}

interface AgentCandidateLoader {
  config: {
    agents: ReadonlyMap<string, AgentDefinition>;
  };
  resolveForRepo(
    owner: string,
    name: string,
  ): {
    product: ProductConfig;
    agents: AgentDefinition[];
  } | null;
}

interface ReviewBotConfigLoader {
  resolveForRepo(
    owner: string,
    name: string,
  ): {
    product: ProductConfig;
    repo: RepoConfig;
  } | null;
}

interface ReviewBotConfigReader {
  readReviewBotConfig(
    product: ProductConfig,
    repo: RepoConfig,
    options?: {
      reviewRepoPath?: string;
    },
  ): Promise<ReviewBotContext>;
}

export function resolveConfiguredAgent(
  loader: ConfiguredAgentLoader,
  repo: RepoForWorktree,
  agentKey: string,
): AgentDefinition | null {
  const resolved = loader.resolveForRepo(repo.owner, repo.name);
  if (resolved === null) {
    return null;
  }
  return resolved.agents.find((agent) => agent.key === agentKey) ?? null;
}

export function resolveConfiguredAgents(
  loader: AgentCandidateLoader,
  repo: RepoForWorktree,
): AgentDefinition[] {
  const resolved = loader.resolveForRepo(repo.owner, repo.name);
  if (resolved === null) {
    return [];
  }
  if (resolved.product.agentSelectionMode === 'explicit') {
    return resolved.product.agents.map((agentKey) => {
      const agent = loader.config.agents.get(agentKey);
      if (agent === undefined) {
        throw new Error(`configured Agent ${JSON.stringify(agentKey)} is not loaded`);
      }
      return applyProductRuntimeOverride(resolved.product, { ...agent, defaultEnabled: true });
    });
  }
  return [...loader.config.agents.values()].map((agent) =>
    applyProductRuntimeOverride(resolved.product, agent),
  );
}

export async function resolveReviewBotConfig(
  loader: ReviewBotConfigLoader,
  reader: ReviewBotConfigReader,
  repo: RepoForWorktree,
  worktreePath?: string,
): Promise<ReviewBotContext> {
  const resolved = loader.resolveForRepo(repo.owner, repo.name);
  if (resolved === null) {
    return EMPTY_REVIEW_BOT_CONTEXT;
  }
  const options =
    worktreePath === undefined
      ? undefined
      : {
          reviewRepoPath: worktreePath,
        };
  return await reader.readReviewBotConfig(resolved.product, resolved.repo, options);
}

// Run only when executed directly, not when imported by tests.
if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('failed to start bot-worker', error);
    process.exit(1);
  });
}
