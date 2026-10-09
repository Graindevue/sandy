import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { api } from '@sandy/convex-backend/api';
import { ConvexHttpClient } from 'convex/browser';
import { BotConfigReader } from './config/bot-config-reader.js';
import { ConfigLoader } from './config/loader.js';
import { defaultCloneBaseDir, defaultConfigLoaderOptions } from './config/paths.js';
import {
  resolveConfiguredAgent,
  resolveConfiguredAgents,
  resolveReviewBotConfig,
} from './config/review-config.js';
import { CloneManager } from './git/clone-manager.js';
import { GitHubAppClient } from './github/app-client.js';
import type { PullRequestFacts, RepoRef } from './github/types.js';
import { disabledArchetypeAssigner } from './learning/archetype-assigner.js';
import { ConvexSink } from './state/convex-sink.js';
import { CodexExecRunner, type ReviewTestMode } from './worker/codex-exec-runner.js';
import { ConvexExecutionStore } from './worker/execution-store.js';
import { PullRequestPoster } from './worker/poster.js';
import { ReviewExecutor } from './worker/review-executor.js';

export interface ReviewActionConfig {
  root: string;
  repository: RepoRef;
  prNumber: number;
  configPath: string;
  convexUrl: string;
  appId: string;
  privateKeyPath: string;
  codexHome: string;
  cloneDir: string;
  runnerTempDir?: string;
  maxChangedLines: number;
  testMode: ReviewTestMode;
  testTimeoutMs: number;
}

export function loadReviewActionConfig(env: NodeJS.ProcessEnv): ReviewActionConfig {
  const root = resolve(env.SANDY_ROOT ?? process.cwd());
  const fullName = requiredEnv(env, 'SANDY_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error('SANDY_REPOSITORY must be owner/repo');
  }
  const [owner, name] = fullName.split('/') as [string, string];
  return {
    root,
    repository: { owner, name },
    prNumber: positiveInteger(requiredEnv(env, 'SANDY_PR_NUMBER'), 'SANDY_PR_NUMBER'),
    configPath: resolve(root, requiredEnv(env, 'SANDY_CONFIG_PATH')),
    convexUrl: requiredEnv(env, 'CONVEX_URL'),
    appId: requiredEnv(env, 'GITHUB_APP_ID'),
    privateKeyPath: resolve(root, requiredEnv(env, 'GITHUB_APP_PRIVATE_KEY_PATH')),
    codexHome: resolve(root, requiredEnv(env, 'CODEX_HOME')),
    cloneDir: resolve(defaultCloneBaseDir(env)),
    ...(env.RUNNER_TEMP ? { runnerTempDir: resolve(env.RUNNER_TEMP) } : {}),
    maxChangedLines: positiveInteger(
      env.SANDY_REVIEW_MAX_CHANGED_LINES ?? '5000',
      'SANDY_REVIEW_MAX_CHANGED_LINES',
    ),
    testMode: reviewTestMode(env.SANDY_REVIEW_TEST_MODE ?? 'targeted'),
    testTimeoutMs: suiteTestTimeout(env.SANDY_REVIEW_TEST_TIMEOUT_SECONDS ?? '120'),
  };
}

export function assertReviewablePullRequest(
  repo: RepoRef,
  pr: PullRequestFacts | null,
): asserts pr is PullRequestFacts {
  if (pr === null) throw new Error('Pull request could not be resolved');
  if (pr.state !== 'open') throw new Error('Sandy only reviews open pull requests');
  if (
    pr.headRepo === null ||
    pr.headRepo.owner.toLowerCase() !== repo.owner.toLowerCase() ||
    pr.headRepo.name.toLowerCase() !== repo.name.toLowerCase()
  ) {
    throw new Error('Sandy declines fork pull requests');
  }
  if (!/^[a-f0-9]{40}$/i.test(pr.headSha)) throw new Error('Pull request has an invalid head SHA');
}

/** Exit successfully only when the requested Review produced its complete result. */
export async function runReviewAction(
  config: ReviewActionConfig,
  signal?: AbortSignal,
): Promise<void> {
  const options = defaultConfigLoaderOptions(config.root);
  const loader = await ConfigLoader.create({ ...options, botYamlPath: config.configPath });
  const configured = loader.resolveForRepo(config.repository.owner, config.repository.name);
  if (configured === null)
    throw new Error('Requested repository is not in the Sandy Product configuration');
  const github = new GitHubAppClient({
    appId: config.appId,
    privateKey: await readFile(config.privateKeyPath, 'utf8'),
  });
  if (!(await github.repositoryIsPrivate(config.repository)))
    throw new Error('ChatGPT-managed CI authentication requires a private repository');
  const pr = await github.resolvePullRequest(config.repository, config.prNumber);
  assertReviewablePullRequest(config.repository, pr);
  signal?.throwIfAborted();

  const client = new ConvexHttpClient(config.convexUrl);
  // Existing public Convex mutations work with HTTP clients; no reactive client
  // or deployment change is required for a one-shot Actions invocation.
  await client.mutation(api.products.syncProduct, {
    slug: configured.product.slug,
    name: configured.product.name,
    repos: configured.product.repos.map(({ owner, name, fullName, defaultBranch }) => ({
      owner,
      name,
      fullName,
      defaultBranch,
    })),
  });
  const sink = new ConvexSink(client);
  const repoId = await sink.ensureRepo(config.repository, configured.repo.defaultBranch);
  const pullRequestId = await sink.upsertPullRequest({
    repoId,
    number: pr.number,
    state: pr.state,
    draft: pr.draft,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    title: pr.title,
    author: pr.author,
    url: pr.url,
  });
  await sink.setReviewActive(pullRequestId, true);
  const jobId = await sink.enqueueReviewJob({
    pullRequestId,
    repoId,
    headSha: pr.headSha,
    trigger: 'mention',
    agentKeys: resolveConfiguredAgents(loader, configured.repo).map((agent) => agent.key),
  });
  if (
    !(await client.mutation(api.reviewJobs.claim, { jobId: jobId as never, claimedAt: Date.now() }))
  )
    throw new Error('Could not claim the requested ReviewJob');
  console.info(
    `Sandy ReviewJob ${jobId}: ${config.repository.owner}/${config.repository.name}#${pr.number} at ${pr.headSha}`,
  );

  const cloneManager = new CloneManager({
    baseDir: config.cloneDir,
    cloneUrl: (repo) => github.cloneUrlForRepo(repo),
    ...(signal !== undefined ? { signal } : {}),
  });
  const botConfigReader = new BotConfigReader({
    repoPath: async (repo) => {
      await cloneManager.ensureCloned(repo);
      return cloneManager.repoPath(repo);
    },
  });
  const store = new ConvexExecutionStore(client);
  const poster = new PullRequestPoster(github);
  const executor = new ReviewExecutor({
    store,
    cloneManager,
    diffInspector: github,
    runner: new CodexExecRunner({
      codexHome: config.codexHome,
      testMode: config.testMode,
      testTimeoutMs: config.testTimeoutMs,
      protectedPaths: [
        config.privateKeyPath,
        config.configPath,
        resolve(config.root, '.config'),
        ...(config.runnerTempDir ? [resolve(config.runnerTempDir, '_runner_file_commands')] : []),
      ],
    }),
    poster: {
      postReviewResult: async (input) => {
        const current = await github.resolvePullRequest(config.repository, config.prNumber);
        if (current?.state !== 'open' || current.headSha !== pr.headSha)
          throw new Error(
            'Pull request changed during the review; request a review of the current head',
          );
        return await poster.postReviewResult(input);
      },
      postScopeDeclined: (input) => poster.postScopeDeclined(input),
    },
    statusChecks: github,
    archetypeAssigner: disabledArchetypeAssigner,
    ...(signal !== undefined ? { signal } : {}),
    maxChangedLines: config.maxChangedLines,
    manifestBuilder: {
      buildManifest: async (productId, repos) => {
        const { buildManifest } = await import('@sandy/manifest-builder');
        return await buildManifest(productId, repos);
      },
    },
    resolveAgent: (repo, key) => resolveConfiguredAgent(loader, repo, key),
    resolveAgents: (repo) => resolveConfiguredAgents(loader, repo),
    resolveReviewBotConfig: ({ repo, worktreePath }) =>
      resolveReviewBotConfig(loader, botConfigReader, repo, worktreePath),
  });
  const result = await executor.executeClaimedJob(jobId);
  const status = await store.getReviewJobStatus(jobId);
  if (status !== 'completed' || result.failedAgentCount > 0)
    throw new Error(
      `Sandy ReviewJob ${jobId} ended as ${status ?? 'missing'} with ${result.failedAgentCount} failed Agent Run(s)`,
    );
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function positiveInteger(raw: string, key: string): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error(`${key} must be a positive integer`);
  return Number(raw);
}

function reviewTestMode(raw: string): ReviewTestMode {
  if (raw !== 'targeted' && raw !== 'suite')
    throw new Error('SANDY_REVIEW_TEST_MODE must be targeted or suite');
  return raw;
}

function suiteTestTimeout(raw: string): number {
  const seconds = positiveInteger(raw, 'SANDY_REVIEW_TEST_TIMEOUT_SECONDS');
  if (seconds > 600) throw new Error('SANDY_REVIEW_TEST_TIMEOUT_SECONDS must be between 1 and 600');
  return seconds * 1000;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Review exceeded the 25 minute execution limit')),
    25 * 60 * 1000,
  );
  timeout.unref();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => controller.abort(new Error(`Review interrupted by ${signal}`)));
  runReviewAction(loadReviewActionConfig(process.env), controller.signal)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(timeout));
}
