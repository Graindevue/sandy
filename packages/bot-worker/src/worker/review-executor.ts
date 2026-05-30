import type {
  AgentDefinition,
  AgentRunStatus,
  ApiSurfaceManifestBuildResult,
  ApiSurfaceRepoInput,
  Confidence,
  Finding,
  ReviewJobStatus,
} from '@sandy/shared-types';
import { EMPTY_REVIEW_BOT_CONTEXT, type ReviewBotContext } from '../config/review-bot-context.js';
import { type AgentSelectionRepo, selectAgentsForReview } from './agent-selector.js';
import {
  isReviewSupersededError,
  type ReviewCancellationRegistry,
  ReviewSupersededError,
} from './cancellation.js';
import { parseFindingsPayload } from './findings-parser.js';
import type { PersistedFinding, PostedFinding, PullRequestTarget } from './poster.js';
import {
  materializeReviewWorkspace,
  type ProductRepoForReview,
  type RepoForWorktree,
  type ReviewCloneManager,
  type ReviewWorktree,
} from './review-workspace.js';
import type { RunnerPullRequest, RunnerSiblingWorktree } from './sandcastle-runner.js';

export type {
  ProductRepoForReview,
  RepoForWorktree,
  ReviewCloneManager,
  ReviewWorktree,
  WorktreeRequest,
} from './review-workspace.js';

export interface ReviewJobContext {
  job: {
    id: string;
    pullRequestId: string;
    repoId: string;
    headSha: string;
    agentKeys: string[];
    confidenceScore: Confidence;
    agentRuns: string[];
    siblingShas: Record<string, string>;
  };
  repo: {
    id: string;
    owner: string;
    name: string;
    defaultBranch: string;
  };
  product: {
    id: string;
    slug: string;
    name: string;
    repos: ProductRepoForReview[];
  };
  pullRequest: {
    id: string;
    number: number;
    headSha: string;
    baseRef: string;
    title: string;
    url: string;
  };
}

export interface RecordFindingInput {
  reviewJobId: string;
  pullRequestId: string;
  finding: Finding;
}

export interface RecordAgentRunInput {
  reviewJobId: string;
  agentKey: string;
  status: AgentRunStatus;
  startedAt: number;
  finishedAt: number;
  findingCount: number;
  error?: string;
}

export interface ReviewExecutionStore {
  getReviewJobContext(jobId: string): Promise<ReviewJobContext | null>;
  getReviewJobStatus(jobId: string): Promise<ReviewJobStatus | null>;
  recordApiSurfaceManifest(input: {
    productId: string;
    repoShas: { repo: string; sha: string }[];
    markdown: string;
    builtAt: number;
  }): Promise<void>;
  recordFinding(input: RecordFindingInput): Promise<string>;
  markFindingPosted(findingId: string, githubCommentId: number): Promise<void>;
  recordAgentRun(input: RecordAgentRunInput): Promise<void>;
  markCompleted(jobId: string, finishedAt: number): Promise<void>;
  markFailed(jobId: string, finishedAt: number, error: string): Promise<void>;
}

export interface ReviewDiffInspector {
  changedLineCount(target: PullRequestTarget, ignorePatterns?: readonly string[]): Promise<number>;
}

export interface ReviewAgentRunner {
  runAgent(input: {
    agent: AgentDefinition;
    worktreePath: string;
    pullRequest: RunnerPullRequest;
    apiSurfaceManifest?: string;
    siblingWorktrees?: readonly RunnerSiblingWorktree[];
    botConfig?: ReviewBotContext;
    signal?: AbortSignal;
  }): Promise<string>;
}

type ReviewAgentRunInput = Parameters<ReviewAgentRunner['runAgent']>[0];

export interface ReviewPoster {
  postReviewResult(input: {
    target: PullRequestTarget;
    agentKey: string;
    findings: PersistedFinding[];
    siblingShas: Record<string, string>;
    summary?: string;
  }): Promise<PostedFinding[]>;
  postScopeDeclined(input: {
    target: PullRequestTarget;
    changedLines: number;
    maxChangedLines: number;
  }): Promise<void>;
}

export interface ReviewManifestBuilder {
  buildManifest(
    productId: string,
    repoShas: readonly ApiSurfaceRepoInput[],
  ): Promise<ApiSurfaceManifestBuildResult>;
}

export interface ResolveReviewBotConfigInput {
  context: ReviewJobContext;
  repo: RepoForWorktree;
  worktreePath?: string;
}

export interface ReviewExecutorOptions {
  store: ReviewExecutionStore;
  cloneManager: ReviewCloneManager;
  diffInspector: ReviewDiffInspector;
  runner: ReviewAgentRunner;
  poster: ReviewPoster;
  resolveAgent(repo: RepoForWorktree, agentKey: string): AgentDefinition | null;
  resolveAgents?: (repo: RepoForWorktree) => readonly AgentDefinition[];
  manifestBuilder?: ReviewManifestBuilder;
  resolveReviewBotConfig?: (input: ResolveReviewBotConfigInput) => Promise<ReviewBotContext>;
  cancellationRegistry?: ReviewCancellationRegistry;
  maxChangedLines?: number;
  agentTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_CHANGED_LINES = 5000;
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export class ReviewExecutor {
  readonly #store: ReviewExecutionStore;
  readonly #cloneManager: ReviewCloneManager;
  readonly #diffInspector: ReviewDiffInspector;
  readonly #runner: ReviewAgentRunner;
  readonly #poster: ReviewPoster;
  readonly #resolveAgent: (repo: RepoForWorktree, agentKey: string) => AgentDefinition | null;
  readonly #resolveAgents: ((repo: RepoForWorktree) => readonly AgentDefinition[]) | null;
  readonly #manifestBuilder: ReviewManifestBuilder | null;
  readonly #resolveReviewBotConfig: (
    input: ResolveReviewBotConfigInput,
  ) => Promise<ReviewBotContext>;
  readonly #cancellationRegistry: ReviewCancellationRegistry | null;
  readonly #maxChangedLines: number;
  readonly #agentTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: ReviewExecutorOptions) {
    this.#store = options.store;
    this.#cloneManager = options.cloneManager;
    this.#diffInspector = options.diffInspector;
    this.#runner = options.runner;
    this.#poster = options.poster;
    this.#resolveAgent = options.resolveAgent;
    this.#resolveAgents = options.resolveAgents ?? null;
    this.#manifestBuilder = options.manifestBuilder ?? null;
    this.#resolveReviewBotConfig = options.resolveReviewBotConfig ?? resolveEmptyReviewBotContext;
    this.#cancellationRegistry = options.cancellationRegistry ?? null;
    this.#maxChangedLines = options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
    this.#agentTimeoutMs = options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  async executeClaimedJob(jobId: string): Promise<void> {
    let context: ReviewJobContext | null = null;
    const worktrees: ReviewWorktree[] = [];
    const cancellation = this.#cancellationRegistry?.register(jobId);
    const cancellationSignal = cancellation?.signal;

    try {
      cancellationSignal?.throwIfAborted();
      context = await this.#requiredContext(jobId);
      const repo = repoForWorktree(context);
      const target = pullRequestTarget(context);
      const preflightBotConfig = await this.#resolveReviewBotConfig({ context, repo });
      const changedLines = await this.#diffInspector.changedLineCount(
        target,
        preflightBotConfig.ignorePatterns,
      );
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);

      if (changedLines > this.#maxChangedLines) {
        await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
        await this.#completeScopeDecline(jobId, target, changedLines);
        return;
      }

      const workspace = await materializeReviewWorkspace(this.#cloneManager, context);
      worktrees.push(...workspace.worktrees);
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      const manifest = await this.#buildAndRecordManifest(context, workspace.manifestRepos);
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      const reviewBotConfig = await this.#resolveReviewBotConfig({
        context,
        repo,
        worktreePath: workspace.prWorktree.path,
      });
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);

      const agents = await this.#selectAgents(
        context,
        repo,
        workspace.manifestRepos,
        reviewBotConfig,
      );
      await this.#runSelectedAgents({
        context,
        target,
        agents,
        workspace,
        manifest,
        reviewBotConfig,
        cancellationSignal,
      });

      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      await this.#store.markCompleted(jobId, this.#now());
    } catch (error) {
      if (isReviewSupersededError(error)) {
        return;
      }
      const message = describeError(error);
      await this.#store.markFailed(jobId, this.#now(), message);
    } finally {
      for (const worktree of worktrees.reverse()) {
        await this.#cloneManager.removeWorktree(worktree);
      }
      cancellation?.dispose();
    }
  }

  async #selectAgents(
    context: ReviewJobContext,
    repo: RepoForWorktree,
    manifestRepos: readonly ApiSurfaceRepoInput[],
    reviewBotConfig: ReviewBotContext,
  ): Promise<AgentDefinition[]> {
    const candidates =
      this.#resolveAgents === null
        ? context.job.agentKeys.map((agentKey) => this.#requiredAgent(repo, agentKey))
        : this.#resolveAgents(repo);

    return await selectAgentsForReview({
      agents: candidates,
      reviewRepoFullName: `${context.repo.owner}/${context.repo.name}`,
      productRepos: manifestRepos.map((manifestRepo) =>
        agentSelectionRepo(manifestRepo, reviewBotConfig),
      ),
    });
  }

  async #runSelectedAgents(input: {
    context: ReviewJobContext;
    target: PullRequestTarget;
    agents: readonly AgentDefinition[];
    workspace: {
      prWorktree: ReviewWorktree;
      siblingWorktrees: readonly RunnerSiblingWorktree[];
    };
    manifest: ApiSurfaceManifestBuildResult | undefined;
    reviewBotConfig: ReviewBotContext;
    cancellationSignal: AbortSignal | undefined;
  }): Promise<void> {
    const results = await Promise.allSettled(
      input.agents.map((agent) => this.#runSelectedAgent({ ...input, agent })),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
  }

  async #runSelectedAgent(input: {
    context: ReviewJobContext;
    target: PullRequestTarget;
    agent: AgentDefinition;
    workspace: {
      prWorktree: ReviewWorktree;
      siblingWorktrees: readonly RunnerSiblingWorktree[];
    };
    manifest: ApiSurfaceManifestBuildResult | undefined;
    reviewBotConfig: ReviewBotContext;
    cancellationSignal: AbortSignal | undefined;
  }): Promise<void> {
    const { context, target, agent, workspace, manifest, reviewBotConfig, cancellationSignal } =
      input;
    const agentStartedAt = this.#now();
    const runInput: ReviewAgentRunInput = {
      agent,
      worktreePath: workspace.prWorktree.path,
      pullRequest: runnerPullRequest(context),
      botConfig: reviewBotConfig,
    };
    if (manifest !== undefined) {
      runInput.apiSurfaceManifest = manifest.markdown;
    }
    if (workspace.siblingWorktrees.length > 0) {
      runInput.siblingWorktrees = workspace.siblingWorktrees;
    }

    try {
      const stdout = await this.#runAgentWithTimeout(runInput, agent.key, cancellationSignal);
      await this.#throwIfCancelledOrSuperseded(context.job.id, cancellationSignal);
      const payload = parseFindingsPayload(stdout);
      const agentFinishedAt = this.#now();

      await this.#store.recordAgentRun({
        reviewJobId: context.job.id,
        agentKey: agent.key,
        status: 'completed',
        startedAt: agentStartedAt,
        finishedAt: agentFinishedAt,
        findingCount: payload.findings.length,
      });

      await this.#throwIfCancelledOrSuperseded(context.job.id, cancellationSignal);
      const persistedFindings = await this.#recordFindings(context, agent.key, payload.findings);
      await this.#throwIfCancelledOrSuperseded(context.job.id, cancellationSignal);
      await this.#postReviewResult(
        target,
        agent.key,
        persistedFindings,
        context.job.siblingShas,
        payload.summary,
      );
    } catch (error) {
      if (isReviewSupersededError(error)) {
        throw error;
      }
      if (isReviewSupersededError(cancellationSignal?.reason)) {
        throw cancellationSignal.reason;
      }

      await this.#throwIfCancelledOrSuperseded(context.job.id, cancellationSignal);
      await this.#store.recordAgentRun({
        reviewJobId: context.job.id,
        agentKey: agent.key,
        status: isAgentTimedOutError(error) ? 'timed_out' : 'failed',
        startedAt: agentStartedAt,
        finishedAt: this.#now(),
        findingCount: 0,
        error: describeError(error),
      });
    }
  }

  async #runAgentWithTimeout(
    input: ReviewAgentRunInput,
    agentKey: string,
    parentSignal: AbortSignal | undefined,
  ): Promise<string> {
    parentSignal?.throwIfAborted();

    const controller = new AbortController();
    let timeoutError: AgentTimedOutError | null = null;
    let onParentAbort: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => {
        timeoutError = new AgentTimedOutError(agentKey, this.#agentTimeoutMs);
        controller.abort(timeoutError);
        reject(timeoutError);
      }, this.#agentTimeoutMs);

      const clear = () => clearTimeout(timeout);
      controller.signal.addEventListener('abort', clear, { once: true });
    });
    const parentAbortPromise = new Promise<never>((_resolve, reject) => {
      if (parentSignal === undefined) {
        return;
      }
      onParentAbort = () => {
        const reason = parentSignal.reason ?? new Error('Review execution was aborted');
        controller.abort(reason);
        reject(reason);
      };
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    });

    try {
      return await Promise.race([
        this.#runner.runAgent({ ...input, signal: controller.signal }),
        timeoutPromise,
        parentAbortPromise,
      ]);
    } catch (error) {
      if (timeoutError !== null && !isAgentTimedOutError(error)) {
        throw timeoutError;
      }
      throw error;
    } finally {
      controller.abort();
      if (parentSignal !== undefined && onParentAbort !== undefined) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  async #requiredContext(jobId: string): Promise<ReviewJobContext> {
    const context = await this.#store.getReviewJobContext(jobId);
    if (context === null) {
      throw new Error(`ReviewJob ${jobId} no longer exists`);
    }
    return context;
  }

  #requiredAgent(repo: RepoForWorktree, agentKey: string): AgentDefinition {
    const agent = this.#resolveAgent(repo, agentKey);
    if (agent === null) {
      throw new Error(
        `Agent ${JSON.stringify(agentKey)} is not configured for ${repo.owner}/${repo.name}`,
      );
    }
    return agent;
  }

  async #completeScopeDecline(
    jobId: string,
    target: PullRequestTarget,
    changedLines: number,
  ): Promise<void> {
    await this.#poster.postScopeDeclined({
      target,
      changedLines,
      maxChangedLines: this.#maxChangedLines,
    });
    await this.#store.markCompleted(jobId, this.#now());
  }

  async #buildAndRecordManifest(
    context: ReviewJobContext,
    manifestRepos: readonly ApiSurfaceRepoInput[],
  ): Promise<ApiSurfaceManifestBuildResult | undefined> {
    if (this.#manifestBuilder === null) {
      return undefined;
    }
    const manifest = await this.#manifestBuilder.buildManifest(context.product.id, manifestRepos);
    await this.#store.recordApiSurfaceManifest({
      productId: context.product.id,
      repoShas: manifest.structured.repoShas,
      markdown: manifest.markdown,
      builtAt: manifest.structured.builtAt,
    });
    return manifest;
  }

  async #recordFindings(
    context: ReviewJobContext,
    agentKey: string,
    findings: Finding[],
  ): Promise<PersistedFinding[]> {
    const persistedFindings: PersistedFinding[] = [];
    for (const finding of findings) {
      const producedFinding: Finding = { ...finding, agentKey };
      const id = await this.#store.recordFinding({
        reviewJobId: context.job.id,
        pullRequestId: context.pullRequest.id,
        finding: producedFinding,
      });
      persistedFindings.push({ id, finding: producedFinding });
    }
    return persistedFindings;
  }

  async #postReviewResult(
    target: PullRequestTarget,
    agentKey: string,
    findings: PersistedFinding[],
    siblingShas: Record<string, string>,
    summary: string | undefined,
  ): Promise<void> {
    const input: {
      target: PullRequestTarget;
      agentKey: string;
      findings: PersistedFinding[];
      siblingShas: Record<string, string>;
      summary?: string;
    } = { target, agentKey, findings, siblingShas };
    if (summary !== undefined) {
      input.summary = summary;
    }

    const posted = await this.#poster.postReviewResult(input);
    for (const postedFinding of posted) {
      await this.#store.markFindingPosted(postedFinding.findingId, postedFinding.commentId);
    }
  }

  async #throwIfCancelledOrSuperseded(jobId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const status = await this.#store.getReviewJobStatus(jobId);
    signal?.throwIfAborted();
    if (status === 'superseded') {
      throw new ReviewSupersededError(jobId);
    }
  }
}

function repoForWorktree(context: ReviewJobContext): RepoForWorktree {
  return {
    owner: context.repo.owner,
    name: context.repo.name,
    defaultBranch: context.repo.defaultBranch,
  };
}

function pullRequestTarget(context: ReviewJobContext): PullRequestTarget {
  return {
    owner: context.repo.owner,
    repo: context.repo.name,
    pullNumber: context.pullRequest.number,
    headSha: context.job.headSha,
  };
}

function runnerPullRequest(context: ReviewJobContext): RunnerPullRequest {
  return {
    owner: context.repo.owner,
    repo: context.repo.name,
    number: context.pullRequest.number,
    headSha: context.job.headSha,
    baseRef: context.pullRequest.baseRef,
    title: context.pullRequest.title,
    url: context.pullRequest.url,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveEmptyReviewBotContext(): Promise<ReviewBotContext> {
  return EMPTY_REVIEW_BOT_CONTEXT;
}

function agentSelectionRepo(
  manifestRepo: ApiSurfaceRepoInput,
  reviewBotConfig: ReviewBotContext,
): AgentSelectionRepo {
  const repo: AgentSelectionRepo = {
    fullName: manifestRepo.fullName,
    worktreePath: manifestRepo.worktreePath,
  };
  const agentsYaml = repoAgentsYaml(reviewBotConfig, manifestRepo.fullName);
  if (agentsYaml !== undefined) {
    repo.agentsYaml = agentsYaml;
  }
  return repo;
}

function repoAgentsYaml(config: ReviewBotContext, fullName: string): string | null | undefined {
  if (!('repos' in config) || !Array.isArray(config.repos)) {
    return undefined;
  }
  const repoConfig = config.repos.find((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('repo' in entry)) {
      return false;
    }
    const repo = (entry as { repo?: unknown }).repo;
    return (
      typeof repo === 'object' &&
      repo !== null &&
      'fullName' in repo &&
      typeof (repo as { fullName?: unknown }).fullName === 'string' &&
      (repo as { fullName: string }).fullName.toLowerCase() === fullName.toLowerCase()
    );
  });
  if (typeof repoConfig !== 'object' || repoConfig === null || !('agentsYaml' in repoConfig)) {
    return undefined;
  }
  const agentsYaml = (repoConfig as { agentsYaml?: unknown }).agentsYaml;
  return typeof agentsYaml === 'string' || agentsYaml === null ? agentsYaml : undefined;
}

class AgentTimedOutError extends Error {
  constructor(agentKey: string, timeoutMs: number) {
    super(`Agent ${JSON.stringify(agentKey)} exceeded ${timeoutMs}ms execution timeout`);
    this.name = 'AgentTimedOutError';
  }
}

function isAgentTimedOutError(error: unknown): error is AgentTimedOutError {
  return error instanceof AgentTimedOutError;
}
