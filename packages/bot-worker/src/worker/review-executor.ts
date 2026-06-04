import type {
  AgentDefinition,
  AgentRunStatus,
  ApiSurfaceManifestBuildResult,
  ApiSurfaceRepoInput,
  Confidence,
  CrossRepoSearchRationale,
  Finding,
  FindingsPayload,
  ReviewJobStatus,
  SiblingShas,
} from '@sandy/shared-types';
import { EMPTY_REVIEW_BOT_CONTEXT, type ReviewBotContext } from '../config/review-bot-context.js';
import {
  type AgentReviewOutput,
  synthesizeAgentOutputs,
  synthesizePostableReview,
} from '../synthesizer/synthesizer.js';
import { type AgentSelectionRepo, selectAgentsForReview } from './agent-selector.js';
import {
  isReviewSupersededError,
  type ReviewCancellationRegistry,
  ReviewSupersededError,
} from './cancellation.js';
import { parseFindingsPayload } from './findings-parser.js';
import type {
  PostedReviewResult,
  PostedSummaryComment,
  PostReviewResultInput,
  PostScopeDeclinedInput,
  PullRequestTarget,
} from './poster.js';
import type {
  ArchetypeAssignedFinding,
  PersistedFinding,
  PostableFinding,
} from './review-findings.js';
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
    checkRunId?: number;
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

export interface RecordSynthesizedReviewInput {
  reviewJobId: string;
  pullRequestId: string;
  confidenceScore: Confidence;
  findings: readonly Finding[];
}

type FailedAgentRunStatus = Extract<AgentRunStatus, 'failed' | 'timed_out'>;

interface RecordAgentRunBaseInput {
  reviewJobId: string;
  agentKey: string;
  startedAt: number;
  finishedAt: number;
}

export type RecordAgentRunInput =
  | (RecordAgentRunBaseInput & {
      status: 'completed';
      findingCount: number;
      crossRepoSearch: CrossRepoSearchRationale;
      error?: never;
    })
  | (RecordAgentRunBaseInput & {
      status: FailedAgentRunStatus;
      findingCount: 0;
      error: string;
      crossRepoSearch?: never;
    });

export interface ReviewExecutionStore {
  getReviewJobContext(jobId: string): Promise<ReviewJobContext | null>;
  getReviewJobStatus(jobId: string): Promise<ReviewJobStatus | null>;
  recordApiSurfaceManifest(input: {
    productId: string;
    repoShas: { repo: string; sha: string }[];
    markdown: string;
    builtAt: number;
  }): Promise<void>;
  recordSiblingShas(jobId: string, siblingShas: SiblingShas): Promise<void>;
  recordSynthesizedReview(input: RecordSynthesizedReviewInput): Promise<PersistedFinding[]>;
  markFindingPosted(findingId: string, githubCommentId: number): Promise<void>;
  recordAgentRun(input: RecordAgentRunInput): Promise<void>;
  setReviewCheckRunId(jobId: string, checkRunId: number): Promise<void>;
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
type AgentExecutionOutcome =
  | {
      status: 'completed';
      startedAt: number;
      finishedAt: number;
      payload: FindingsPayload;
    }
  | {
      status: FailedAgentRunStatus;
      startedAt: number;
      finishedAt: number;
      error: string;
    };

type SelectedAgentReviewResult =
  | { status: 'completed'; output: AgentReviewOutput }
  | { status: 'failed' };

interface SelectedAgentReviewResults {
  outputs: AgentReviewOutput[];
  failedAgentCount: number;
  selectedAgentCount: number;
}

interface CompletedReviewCheckOutcome {
  conclusion: ReviewStatusCheckConclusion;
  verdict: string;
}

interface CompleteStatusCheckInput {
  context: ReviewJobContext;
  target: PullRequestTarget;
  checkRunId: number | null;
  outcome: CompletedReviewCheckOutcome;
  summaryComment?: PostedSummaryComment;
}

interface AgentWorkspace {
  prWorktree: ReviewWorktree;
  siblingWorktrees: readonly RunnerSiblingWorktree[];
  siblingShas: SiblingShas;
}

interface AgentExecutionInput {
  context: ReviewJobContext;
  agent: AgentDefinition;
  workspace: AgentWorkspace;
  manifest: ApiSurfaceManifestBuildResult | undefined;
  reviewBotConfig: ReviewBotContext;
  cancellationSignal: AbortSignal | undefined;
}

export interface ReviewPoster {
  postReviewResult(input: PostReviewResultInput): Promise<PostedReviewResult>;
  postScopeDeclined(input: PostScopeDeclinedInput): Promise<PostedSummaryComment>;
}

export type ReviewStatusCheckConclusion = 'success' | 'neutral' | 'failure';

export interface CreateReviewStatusCheckInput {
  owner: string;
  repo: string;
  headSha: string;
  pullRequestUrl: string;
  startedAt: number;
}

export interface CompleteReviewStatusCheckInput {
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: ReviewStatusCheckConclusion;
  detailsUrl: string;
  summaryCommentUrl?: string;
  verdict: string;
  completedAt: number;
}

export interface ReviewStatusCheckReporter {
  createInProgress(input: CreateReviewStatusCheckInput): Promise<{ id: number }>;
  complete(input: CompleteReviewStatusCheckInput): Promise<void>;
}

export interface ReviewExecutorLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface ReviewArchetypeAssigner {
  assignArchetypes(findings: readonly PersistedFinding[]): Promise<ArchetypeAssignedFinding[]>;
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
  statusChecks?: ReviewStatusCheckReporter;
  archetypeAssigner: ReviewArchetypeAssigner;
  resolveAgent(repo: RepoForWorktree, agentKey: string): AgentDefinition | null;
  resolveAgents?: (repo: RepoForWorktree) => readonly AgentDefinition[];
  manifestBuilder?: ReviewManifestBuilder;
  resolveReviewBotConfig?: (input: ResolveReviewBotConfigInput) => Promise<ReviewBotContext>;
  cancellationRegistry?: ReviewCancellationRegistry;
  maxChangedLines?: number;
  agentTimeoutMs?: number;
  now?: () => number;
  logger?: ReviewExecutorLogger;
}

const DEFAULT_MAX_CHANGED_LINES = 5000;
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export class ReviewExecutor {
  readonly #store: ReviewExecutionStore;
  readonly #cloneManager: ReviewCloneManager;
  readonly #diffInspector: ReviewDiffInspector;
  readonly #runner: ReviewAgentRunner;
  readonly #poster: ReviewPoster;
  readonly #statusChecks: ReviewStatusCheckReporter | null;
  readonly #archetypeAssigner: ReviewArchetypeAssigner;
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
  readonly #logger: ReviewExecutorLogger;

  constructor(options: ReviewExecutorOptions) {
    this.#store = options.store;
    this.#cloneManager = options.cloneManager;
    this.#diffInspector = options.diffInspector;
    this.#runner = options.runner;
    this.#poster = options.poster;
    this.#statusChecks = options.statusChecks ?? null;
    this.#archetypeAssigner = options.archetypeAssigner;
    this.#resolveAgent = options.resolveAgent;
    this.#resolveAgents = options.resolveAgents ?? null;
    this.#manifestBuilder = options.manifestBuilder ?? null;
    this.#resolveReviewBotConfig = options.resolveReviewBotConfig ?? resolveEmptyReviewBotContext;
    this.#cancellationRegistry = options.cancellationRegistry ?? null;
    this.#maxChangedLines = options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
    this.#agentTimeoutMs = options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? console;
  }

  async executeClaimedJob(jobId: string): Promise<void> {
    let context: ReviewJobContext | null = null;
    let target: PullRequestTarget | null = null;
    let checkRunId: number | null = null;
    const worktrees: ReviewWorktree[] = [];
    const cancellation = this.#cancellationRegistry?.register(jobId);
    const cancellationSignal = cancellation?.signal;

    try {
      cancellationSignal?.throwIfAborted();
      context = await this.#requiredContext(jobId);
      const repo = repoForWorktree(context);
      target = pullRequestTarget(context);
      checkRunId = context.job.checkRunId ?? (await this.#createStatusCheck(context));
      const preflightBotConfig = await this.#resolveReviewBotConfig({ context, repo });
      const changedLines = await this.#diffInspector.changedLineCount(
        target,
        preflightBotConfig.ignorePatterns,
      );
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);

      if (changedLines > this.#maxChangedLines) {
        await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
        const summaryComment = await this.#completeScopeDecline(jobId, target, changedLines);
        await this.#completeStatusCheck({
          context,
          target,
          checkRunId,
          outcome: {
            conclusion: 'neutral',
            verdict: 'Sandy skipped this review',
          },
          summaryComment,
        });
        return;
      }

      const workspace = await materializeReviewWorkspace(this.#cloneManager, context);
      worktrees.push(...workspace.worktrees);
      await this.#store.recordSiblingShas(jobId, workspace.siblingShas);
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
      const agentResults = await this.#runSelectedAgents({
        context,
        agents,
        workspace,
        manifest,
        reviewBotConfig,
        cancellationSignal,
      });
      let postedReview: PostedReviewResult | null = null;
      if (agentResults.outputs.length > 0) {
        postedReview = await this.#synthesizePersistAndPostReview({
          context,
          target,
          agentOutputs: agentResults.outputs,
          changedLineCount: changedLines,
          siblingShas: workspace.siblingShas,
          cancellationSignal,
        });
      }

      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      await this.#store.markCompleted(jobId, this.#now());
      const statusCheckInput: CompleteStatusCheckInput = {
        context,
        target,
        checkRunId,
        outcome: completedReviewCheckOutcome({
          selectedAgentCount: agentResults.selectedAgentCount,
          failedAgentCount: agentResults.failedAgentCount,
          postedFindingCount: postedReview?.postedFindings.length ?? 0,
        }),
      };
      if (postedReview !== null) {
        statusCheckInput.summaryComment = postedReview.summaryComment;
      }
      await this.#completeStatusCheck(statusCheckInput);
    } catch (error) {
      if (isReviewSupersededError(error)) {
        return;
      }
      const message = describeError(error);
      await this.#store.markFailed(jobId, this.#now(), message);
      if (context !== null && target !== null) {
        await this.#completeStatusCheck({
          context,
          target,
          checkRunId,
          outcome: {
            conclusion: 'failure',
            verdict: 'Sandy failed to run',
          },
        });
      }
    } finally {
      for (const worktree of worktrees.reverse()) {
        await this.#cloneManager.removeWorktree(worktree);
      }
      cancellation?.dispose();
    }
  }

  async #createStatusCheck(context: ReviewJobContext): Promise<number | null> {
    if (this.#statusChecks === null) {
      return null;
    }

    let checkRunId: number;
    try {
      const check = await this.#statusChecks.createInProgress({
        owner: context.repo.owner,
        repo: context.repo.name,
        headSha: context.job.headSha,
        pullRequestUrl: context.pullRequest.url,
        startedAt: this.#now(),
      });
      checkRunId = check.id;
    } catch (error) {
      this.#logger.warn(`failed to create Sandy Check Run for ReviewJob ${context.job.id}`, error);
      return null;
    }

    try {
      await this.#store.setReviewCheckRunId(context.job.id, checkRunId);
    } catch (error) {
      this.#logger.warn(
        `failed to persist Sandy Check Run ${checkRunId} for ReviewJob ${context.job.id}`,
        error,
      );
    }
    return checkRunId;
  }

  async #completeStatusCheck(input: CompleteStatusCheckInput): Promise<void> {
    if (this.#statusChecks === null || input.checkRunId === null) {
      return;
    }

    try {
      await this.#statusChecks.complete({
        owner: input.target.owner,
        repo: input.target.repo,
        checkRunId: input.checkRunId,
        conclusion: input.outcome.conclusion,
        detailsUrl: input.summaryComment?.url ?? input.context.pullRequest.url,
        ...(input.summaryComment === undefined
          ? {}
          : { summaryCommentUrl: input.summaryComment.url }),
        verdict: input.outcome.verdict,
        completedAt: this.#now(),
      });
    } catch (error) {
      this.#logger.warn(
        `failed to update Sandy Check Run ${input.checkRunId} for ReviewJob ${input.context.job.id}`,
        error,
      );
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
    agents: readonly AgentDefinition[];
    workspace: AgentWorkspace;
    manifest: ApiSurfaceManifestBuildResult | undefined;
    reviewBotConfig: ReviewBotContext;
    cancellationSignal: AbortSignal | undefined;
  }): Promise<SelectedAgentReviewResults> {
    const results = await Promise.allSettled(
      input.agents.map((agent) => this.#runSelectedAgent({ ...input, agent })),
    );

    const outputs: AgentReviewOutput[] = [];
    let failedAgentCount = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      if (result.value.status === 'failed') {
        failedAgentCount += 1;
        continue;
      }
      outputs.push(result.value.output);
    }
    return {
      outputs,
      failedAgentCount,
      selectedAgentCount: input.agents.length,
    };
  }

  async #runSelectedAgent(input: AgentExecutionInput): Promise<SelectedAgentReviewResult> {
    const { context, agent } = input;
    const outcome = await this.#executeAgent(input);
    if (outcome.status !== 'completed') {
      await this.#store.recordAgentRun({
        reviewJobId: context.job.id,
        agentKey: agent.key,
        status: outcome.status,
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
        findingCount: 0,
        error: outcome.error,
      });
      return { status: 'failed' };
    }

    await this.#store.recordAgentRun({
      reviewJobId: context.job.id,
      agentKey: agent.key,
      status: 'completed',
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      findingCount: outcome.payload.findings.length,
      crossRepoSearch: outcome.payload.crossRepoSearch,
    });

    return { status: 'completed', output: { agentKey: agent.key, payload: outcome.payload } };
  }

  async #executeAgent(input: AgentExecutionInput): Promise<AgentExecutionOutcome> {
    const { context, agent, cancellationSignal } = input;
    const startedAt = this.#now();
    const runInput = agentRunInput(input);

    try {
      const stdout = await this.#runAgentWithTimeout(runInput, agent.key, cancellationSignal);
      await this.#throwIfCancelledOrSuperseded(context.job.id, cancellationSignal);
      const payload = parseFindingsPayload(stdout);
      return {
        status: 'completed',
        startedAt,
        finishedAt: this.#now(),
        payload,
      };
    } catch (error) {
      if (isReviewSupersededError(error)) {
        throw error;
      }
      if (isReviewSupersededError(cancellationSignal?.reason)) {
        throw cancellationSignal.reason;
      }

      await this.#throwIfCancelledOrSuperseded(context.job.id, cancellationSignal);
      return {
        status: isAgentTimedOutError(error) ? 'timed_out' : 'failed',
        startedAt,
        finishedAt: this.#now(),
        error: describeError(error),
      };
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
  ): Promise<PostedSummaryComment> {
    const summaryComment = await this.#poster.postScopeDeclined({
      target,
      changedLines,
      maxChangedLines: this.#maxChangedLines,
    });
    await this.#store.markCompleted(jobId, this.#now());
    return summaryComment;
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

  async #synthesizePersistAndPostReview(input: {
    context: ReviewJobContext;
    target: PullRequestTarget;
    agentOutputs: readonly AgentReviewOutput[];
    changedLineCount: number;
    siblingShas: SiblingShas;
    cancellationSignal: AbortSignal | undefined;
  }): Promise<PostedReviewResult> {
    const synthesized = synthesizeAgentOutputs({
      agentOutputs: input.agentOutputs,
      changedLineCount: input.changedLineCount,
    });
    await this.#throwIfCancelledOrSuperseded(input.context.job.id, input.cancellationSignal);
    const persistedFindings = await this.#store.recordSynthesizedReview({
      reviewJobId: input.context.job.id,
      pullRequestId: input.context.pullRequest.id,
      confidenceScore: synthesized.confidenceScore,
      findings: synthesized.findings,
    });
    await this.#throwIfCancelledOrSuperseded(input.context.job.id, input.cancellationSignal);
    const archetypeAssignedFindings =
      await this.#archetypeAssigner.assignArchetypes(persistedFindings);
    await this.#throwIfCancelledOrSuperseded(input.context.job.id, input.cancellationSignal);
    const postable = synthesizePostableReview({
      archetypeAssignedFindings,
      agentOutputs: input.agentOutputs,
      changedLineCount: input.changedLineCount,
      rawFindingCount: synthesized.rawFindingCount,
    });
    return await this.#postReviewResult(
      input.target,
      postable.findings,
      input.siblingShas,
      postable.summary,
    );
  }

  async #postReviewResult(
    target: PullRequestTarget,
    findings: PostableFinding[],
    siblingShas: SiblingShas,
    summary: string,
  ): Promise<PostedReviewResult> {
    const result = await this.#poster.postReviewResult({ target, findings, siblingShas, summary });
    for (const postedFinding of result.postedFindings) {
      await this.#store.markFindingPosted(postedFinding.findingId, postedFinding.commentId);
    }
    return result;
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

function agentRunInput(input: AgentExecutionInput): ReviewAgentRunInput {
  const runInput: ReviewAgentRunInput = {
    agent: input.agent,
    worktreePath: input.workspace.prWorktree.path,
    pullRequest: runnerPullRequest(input.context),
    botConfig: input.reviewBotConfig,
  };
  if (input.manifest !== undefined) {
    runInput.apiSurfaceManifest = input.manifest.markdown;
  }
  if (input.workspace.siblingWorktrees.length > 0) {
    runInput.siblingWorktrees = input.workspace.siblingWorktrees;
  }
  return runInput;
}

function completedReviewCheckOutcome(input: {
  selectedAgentCount: number;
  failedAgentCount: number;
  postedFindingCount: number;
}): CompletedReviewCheckOutcome {
  const successfulAgentCount = input.selectedAgentCount - input.failedAgentCount;
  if (input.selectedAgentCount > 0 && successfulAgentCount === 0) {
    return {
      conclusion: 'failure',
      verdict: 'Sandy failed to produce review results',
    };
  }

  if (input.failedAgentCount > 0) {
    return {
      conclusion: 'neutral',
      verdict: 'Sandy completed with partial agent failures',
    };
  }

  if (input.postedFindingCount > 0) {
    return {
      conclusion: 'neutral',
      verdict: `Sandy posted ${formatCountWithNoun(input.postedFindingCount, 'finding')}`,
    };
  }

  if (input.selectedAgentCount === 0) {
    return {
      conclusion: 'neutral',
      verdict: 'Sandy completed without running agents',
    };
  }

  return {
    conclusion: 'success',
    verdict: 'Sandy ran cleanly',
  };
}

function formatCountWithNoun(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
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
  const repoConfig = config.repos?.find(
    (entry) => entry.repo.fullName.toLowerCase() === fullName.toLowerCase(),
  );
  return repoConfig?.agentsYaml;
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
