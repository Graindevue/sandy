import type {
  AgentDefinition,
  AgentRunStatus,
  ApiSurfaceManifestBuildResult,
  ApiSurfaceRepoInput,
  Finding,
  ReviewJobStatus,
} from '@sandy/shared-types';
import {
  isReviewSupersededError,
  type ReviewCancellationRegistry,
  ReviewSupersededError,
} from './cancellation.js';
import { parseFindingsPayload } from './findings-parser.js';
import type { PersistedFinding, PostedFinding, PullRequestTarget } from './poster.js';
import type { RunnerPullRequest } from './sandcastle-runner.js';

export interface ReviewJobContext {
  job: {
    id: string;
    pullRequestId: string;
    repoId: string;
    headSha: string;
    agentKeys: string[];
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

export interface ProductRepoForReview {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface RecordFindingInput {
  reviewJobId: string;
  pullRequestId: string;
  agentKey: string;
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

export interface ReviewWorktree {
  path: string;
}

export interface ReviewCloneManager {
  ensureCloned(repo: RepoForWorktree): Promise<unknown>;
  resolveDefaultBranchSha(repo: RepoForWorktree): Promise<string>;
  createWorktree(repo: RepoForWorktree, request: WorktreeRequest): Promise<ReviewWorktree>;
  removeWorktree(worktree: ReviewWorktree): Promise<void>;
}

export interface RepoForWorktree {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface WorktreeRequest {
  reviewJobId: string;
  sha: string;
}

export interface ReviewDiffInspector {
  changedLineCount(target: PullRequestTarget): Promise<number>;
}

export interface ReviewAgentRunner {
  runLogicAgent(input: {
    agent: AgentDefinition;
    worktreePath: string;
    pullRequest: RunnerPullRequest;
    apiSurfaceManifest?: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

type ReviewAgentRunInput = Parameters<ReviewAgentRunner['runLogicAgent']>[0];

export interface ReviewPoster {
  postReviewResult(input: {
    target: PullRequestTarget;
    agentKey: string;
    findings: PersistedFinding[];
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

export interface ReviewExecutorOptions {
  store: ReviewExecutionStore;
  cloneManager: ReviewCloneManager;
  diffInspector: ReviewDiffInspector;
  runner: ReviewAgentRunner;
  poster: ReviewPoster;
  resolveAgent(repo: RepoForWorktree, agentKey: string): AgentDefinition | null;
  manifestBuilder?: ReviewManifestBuilder;
  cancellationRegistry?: ReviewCancellationRegistry;
  maxChangedLines?: number;
  now?: () => number;
}

const DEFAULT_MAX_CHANGED_LINES = 5000;

export class ReviewExecutor {
  readonly #store: ReviewExecutionStore;
  readonly #cloneManager: ReviewCloneManager;
  readonly #diffInspector: ReviewDiffInspector;
  readonly #runner: ReviewAgentRunner;
  readonly #poster: ReviewPoster;
  readonly #resolveAgent: (repo: RepoForWorktree, agentKey: string) => AgentDefinition | null;
  readonly #manifestBuilder: ReviewManifestBuilder | null;
  readonly #cancellationRegistry: ReviewCancellationRegistry | null;
  readonly #maxChangedLines: number;
  readonly #now: () => number;

  constructor(options: ReviewExecutorOptions) {
    this.#store = options.store;
    this.#cloneManager = options.cloneManager;
    this.#diffInspector = options.diffInspector;
    this.#runner = options.runner;
    this.#poster = options.poster;
    this.#resolveAgent = options.resolveAgent;
    this.#manifestBuilder = options.manifestBuilder ?? null;
    this.#cancellationRegistry = options.cancellationRegistry ?? null;
    this.#maxChangedLines = options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
    this.#now = options.now ?? Date.now;
  }

  async executeClaimedJob(jobId: string): Promise<void> {
    let context: ReviewJobContext | null = null;
    const worktrees: ReviewWorktree[] = [];
    let agentKey: string | null = null;
    let agentStartedAt: number | null = null;
    let agentRunRecorded = false;
    const cancellation = this.#cancellationRegistry?.register(jobId);
    const cancellationSignal = cancellation?.signal;

    try {
      cancellationSignal?.throwIfAborted();
      context = await this.#requiredContext(jobId);
      agentKey = requireLogicAgentKey(context);
      const repo = repoForWorktree(context);
      const agent = this.#requiredAgent(repo, agentKey);
      const target = pullRequestTarget(context);
      const changedLines = await this.#diffInspector.changedLineCount(target);
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);

      if (changedLines > this.#maxChangedLines) {
        await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
        await this.#completeScopeDecline(jobId, target, changedLines);
        return;
      }

      const materialized = await this.#materializeReviewWorktrees(context);
      worktrees.push(...materialized.worktrees);
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      const manifest = await this.#buildAndRecordManifest(context, materialized.manifestRepos);
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);

      agentStartedAt = this.#now();
      const runInput: ReviewAgentRunInput = {
        agent,
        worktreePath: materialized.prWorktree.path,
        pullRequest: runnerPullRequest(context),
      };
      if (manifest !== undefined) {
        runInput.apiSurfaceManifest = manifest.markdown;
      }
      if (cancellationSignal !== undefined) {
        runInput.signal = cancellationSignal;
      }
      const stdout = await this.#runner.runLogicAgent(runInput);
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      const payload = parseFindingsPayload(stdout);
      const agentFinishedAt = this.#now();

      await this.#store.recordAgentRun({
        reviewJobId: context.job.id,
        agentKey,
        status: 'completed',
        startedAt: agentStartedAt,
        finishedAt: agentFinishedAt,
        findingCount: payload.findings.length,
      });
      agentRunRecorded = true;

      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      const persistedFindings = await this.#recordFindings(context, agentKey, payload.findings);
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      await this.#postReviewResult(target, agentKey, persistedFindings, payload.summary);

      await this.#store.markCompleted(jobId, this.#now());
    } catch (error) {
      if (isReviewSupersededError(error)) {
        return;
      }
      const message = describeError(error);
      if (context !== null && agentKey !== null && agentStartedAt !== null && !agentRunRecorded) {
        await this.#recordFailedAgentRun(context, agentKey, agentStartedAt, message);
      }
      await this.#store.markFailed(jobId, this.#now(), message);
    } finally {
      for (const worktree of worktrees.reverse()) {
        await this.#cloneManager.removeWorktree(worktree);
      }
      cancellation?.dispose();
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

  async #materializeReviewWorktrees(context: ReviewJobContext): Promise<{
    prWorktree: ReviewWorktree;
    worktrees: ReviewWorktree[];
    manifestRepos: ApiSurfaceRepoInput[];
  }> {
    const currentRepo = repoForWorktree(context);
    const productRepos = productReposForContext(context);
    const worktrees: ReviewWorktree[] = [];
    const manifestRepos: ApiSurfaceRepoInput[] = [];
    let prWorktree: ReviewWorktree | null = null;

    for (const productRepo of productRepos) {
      const repo = repoForProductRepo(productRepo);
      await this.#cloneManager.ensureCloned(repo);
      const sha = sameRepo(repo, currentRepo)
        ? context.job.headSha
        : await this.#cloneManager.resolveDefaultBranchSha(repo);
      const worktree = await this.#cloneManager.createWorktree(repo, {
        reviewJobId: context.job.id,
        sha,
      });
      worktrees.push(worktree);
      if (sameRepo(repo, currentRepo)) {
        prWorktree = worktree;
      }
      manifestRepos.push({
        owner: productRepo.owner,
        name: productRepo.name,
        fullName: productRepo.fullName,
        defaultBranch: productRepo.defaultBranch,
        worktreePath: worktree.path,
        sha,
      });
    }

    if (prWorktree === null) {
      throw new Error(
        `Product ${context.product.slug} does not include reviewed Repo ${currentRepo.owner}/${currentRepo.name}`,
      );
    }

    return { prWorktree, worktrees, manifestRepos };
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
      const id = await this.#store.recordFinding({
        reviewJobId: context.job.id,
        pullRequestId: context.pullRequest.id,
        agentKey,
        finding,
      });
      persistedFindings.push({ id, finding });
    }
    return persistedFindings;
  }

  async #postReviewResult(
    target: PullRequestTarget,
    agentKey: string,
    findings: PersistedFinding[],
    summary: string | undefined,
  ): Promise<void> {
    const input: {
      target: PullRequestTarget;
      agentKey: string;
      findings: PersistedFinding[];
      summary?: string;
    } = { target, agentKey, findings };
    if (summary !== undefined) {
      input.summary = summary;
    }

    const posted = await this.#poster.postReviewResult(input);
    for (const postedFinding of posted) {
      await this.#store.markFindingPosted(postedFinding.findingId, postedFinding.commentId);
    }
  }

  async #recordFailedAgentRun(
    context: ReviewJobContext,
    agentKey: string,
    startedAt: number,
    error: string,
  ): Promise<void> {
    await this.#store.recordAgentRun({
      reviewJobId: context.job.id,
      agentKey,
      status: 'failed',
      startedAt,
      finishedAt: this.#now(),
      findingCount: 0,
      error,
    });
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

function requireLogicAgentKey(context: ReviewJobContext): string {
  if (context.job.agentKeys.length !== 1 || context.job.agentKeys[0] !== 'logic') {
    throw new Error(
      `Phase 1 can only execute the logic Agent, got ${context.job.agentKeys.join(', ')}`,
    );
  }
  return 'logic';
}

function productReposForContext(context: ReviewJobContext): ProductRepoForReview[] {
  if (context.product.repos.length > 0) {
    return context.product.repos;
  }
  return [
    {
      id: context.repo.id,
      owner: context.repo.owner,
      name: context.repo.name,
      fullName: `${context.repo.owner}/${context.repo.name}`,
      defaultBranch: context.repo.defaultBranch,
    },
  ];
}

function repoForProductRepo(repo: ProductRepoForReview): RepoForWorktree {
  return { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch };
}

function sameRepo(left: RepoForWorktree, right: RepoForWorktree): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
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
