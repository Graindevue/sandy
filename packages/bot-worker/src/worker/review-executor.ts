import type {
  AgentDefinition,
  AgentRunStatus,
  AgentRunUsage,
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
import type {
  AgentRunResult,
  RunnerPullRequest,
  RunnerSiblingWorktree,
} from './codex-exec-runner.js';
import type { DependencyInstallResult } from './dependency-install.js';
import { parseFindingsPayload } from './findings-parser.js';
import type {
  PostedReviewResult,
  PostedSummaryComment,
  PostReviewResultInput,
  PostScopeDeclinedInput,
  PullRequestTarget,
} from './poster.js';
import { isReviewSupersededError, ReviewSupersededError } from './review-errors.js';
import type {
  ArchetypeAssignedFinding,
  PersistedFinding,
  PostableFinding,
} from './review-findings.js';
import {
  type CompleteReviewStatusCheckRunInput,
  completedReviewStatusCheckOutcome,
  REVIEW_STATUS_CHECK_OUTCOMES,
  type ReviewStatusCheckLogger,
  type ReviewStatusCheckReporter,
  type ReviewStatusCheckRun,
  startReviewStatusCheck,
} from './review-status-check.js';
import {
  materializeReviewWorkspace,
  type ProductRepoForReview,
  type RepoForWorktree,
  type ReviewCloneManager,
  type ReviewWorktree,
} from './review-workspace.js';

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
  usage?: AgentRunUsage;
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
  markCompleted(jobId: string, finishedAt: number): Promise<boolean>;
  markFailed(jobId: string, finishedAt: number, error: string): Promise<boolean>;
}

export interface ReviewDiffInspector {
  changedLineCount(target: PullRequestTarget, ignorePatterns?: readonly string[]): Promise<number>;
  changedPaths?(target: PullRequestTarget): Promise<string[]>;
}

export interface ReviewAgentRunner {
  runAgent(input: {
    agent: AgentDefinition;
    worktreePath: string;
    pullRequest: RunnerPullRequest;
    apiSurfaceManifest?: string;
    siblingWorktrees?: readonly RunnerSiblingWorktree[];
    botConfig?: ReviewBotContext;
    dependencyInstall?: DependencyInstallResult;
    signal?: AbortSignal;
  }): Promise<AgentRunResult>;
  /**
   * Install the reviewed Repo's dependencies into the PR worktree, once per
   * Review and before the Agent fan-out. Optional: runners without sandbox
   * install support skip the step and Agents see no toolchain context.
   */
  installDependencies?(input: {
    worktreePath: string;
    cacheKey?: string;
    signal?: AbortSignal;
  }): Promise<DependencyInstallResult>;
}

type ReviewAgentRunInput = Parameters<ReviewAgentRunner['runAgent']>[0];
type AgentExecutionOutcome =
  | {
      status: 'completed';
      startedAt: number;
      finishedAt: number;
      payload: FindingsPayload;
      usage?: AgentRunUsage;
    }
  | {
      status: FailedAgentRunStatus;
      startedAt: number;
      finishedAt: number;
      error: string;
      usage?: AgentRunUsage;
    };

type SelectedAgentReviewResult =
  | { status: 'completed'; output: AgentReviewOutput }
  | { status: 'failed' };

interface SelectedAgentReviewResults {
  outputs: AgentReviewOutput[];
  failedAgentCount: number;
  selectedAgentCount: number;
}

function agentRunRecordInput(
  reviewJobId: string,
  agentKey: string,
  outcome: AgentExecutionOutcome,
): RecordAgentRunInput {
  const base = {
    reviewJobId,
    agentKey,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
  };
  if (outcome.status !== 'completed') {
    return {
      ...base,
      status: outcome.status,
      findingCount: 0,
      error: outcome.error,
    };
  }
  return {
    ...base,
    status: 'completed',
    findingCount: outcome.payload.findings.length,
    crossRepoSearch: outcome.payload.crossRepoSearch,
  };
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
  dependencyInstall: DependencyInstallResult | undefined;
  cancellationSignal: AbortSignal | undefined;
}

export interface ReviewPoster {
  postReviewResult(input: PostReviewResultInput): Promise<PostedReviewResult>;
  postScopeDeclined(input: PostScopeDeclinedInput): Promise<PostedSummaryComment>;
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
  signal?: AbortSignal;
  maxChangedLines?: number;
  agentTimeoutMs?: number;
  now?: () => number;
  logger?: ReviewStatusCheckLogger;
}

const DEFAULT_MAX_CHANGED_LINES = 5000;
// 10 minutes: now that the sandbox has node_modules, Agents execute real
// test suites and type-checks; the heaviest Agent (logic) ran 4 scoped
// vitest suites + a cross-package type-check and could not fit 5 minutes.
// Reviews are manual-only (ADR 0017), so wall-clock is worth a complete run
// — a timeout discards the Agent's entire work product.
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

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
  readonly #signal: AbortSignal | undefined;
  readonly #maxChangedLines: number;
  readonly #agentTimeoutMs: number;
  readonly #now: () => number;
  readonly #logger: ReviewStatusCheckLogger;

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
    this.#signal = options.signal;
    this.#maxChangedLines = options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
    this.#agentTimeoutMs = options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? console;
  }

  async executeClaimedJob(jobId: string): Promise<{ failedAgentCount: number }> {
    let failedAgentCount = 0;
    let context: ReviewJobContext | null = null;
    let statusCheck: ReviewStatusCheckRun | null = null;
    const worktrees: ReviewWorktree[] = [];
    const cancellationSignal = this.#signal;

    try {
      cancellationSignal?.throwIfAborted();
      context = await this.#requiredContext(jobId);
      const repo = repoForWorktree(context);
      const target = pullRequestTarget(context);
      statusCheck = await startReviewStatusCheck({
        context,
        reporter: this.#statusChecks,
        store: this.#store,
        now: this.#now,
        logger: this.#logger,
      });
      const preflightBotConfig = await this.#resolveReviewBotConfig({ context, repo });
      const changedLines = await this.#diffInspector.changedLineCount(
        target,
        preflightBotConfig.ignorePatterns,
      );
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);

      if (changedLines > this.#maxChangedLines) {
        await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
        const summaryComment = await this.#completeScopeDecline(
          jobId,
          target,
          changedLines,
          cancellationSignal,
        );
        await statusCheck.complete({
          outcome: REVIEW_STATUS_CHECK_OUTCOMES.scopeDeclined,
          summaryComment,
        });
        return { failedAgentCount };
      }

      const workspace = await materializeReviewWorkspace(this.#cloneManager, context);
      worktrees.push(...workspace.worktrees);
      await this.#store.recordSiblingShas(jobId, workspace.siblingShas);
      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      // Manifest build and dependency install are independent of each other,
      // so they run concurrently. allSettled keeps the slower one from being
      // orphaned mid-flight (and rejecting unhandled) when the other throws.
      const [manifestSettled, installSettled] = await Promise.allSettled([
        this.#buildAndRecordManifest(context, workspace.manifestRepos),
        this.#installWorkspaceDependencies(
          workspace.prWorktree.path,
          `${context.repo.owner}/${context.repo.name}`,
          cancellationSignal,
        ),
      ]);
      if (manifestSettled.status === 'rejected') {
        throw manifestSettled.reason;
      }
      if (installSettled.status === 'rejected') {
        throw installSettled.reason;
      }
      const manifest = manifestSettled.value;
      const dependencyInstall = installSettled.value;
      const testSummary = reviewTestSummary(dependencyInstall);
      this.#logger.info?.(testSummary);
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
        dependencyInstall,
        cancellationSignal,
      });
      failedAgentCount = agentResults.failedAgentCount;
      let postedReview: PostedReviewResult | null = null;
      if (agentResults.outputs.length > 0) {
        postedReview = await this.#synthesizePersistAndPostReview({
          context,
          target,
          agentOutputs: agentResults.outputs,
          changedLineCount: changedLines,
          siblingShas: workspace.siblingShas,
          cancellationSignal,
          testSummary,
        });
      }

      await this.#throwIfCancelledOrSuperseded(jobId, cancellationSignal);
      await this.#markCompletedOrThrowIfSuperseded(jobId, cancellationSignal);
      const outcome = completedReviewStatusCheckOutcome({
        selectedAgentCount: agentResults.selectedAgentCount,
        failedAgentCount: agentResults.failedAgentCount,
        postedFindingCount: postedReview?.postedFindings.length ?? 0,
      });
      if (
        outcome.conclusion === 'success' &&
        !(dependencyInstall?.status === 'installed' && dependencyInstall.testStatus === 'passed')
      ) {
        outcome.conclusion = 'neutral';
        outcome.verdict = 'Sandy completed review';
      }
      outcome.verdict += `. ${testSummary.replace(/\.$/, '')}`;
      const statusCheckCompletion: CompleteReviewStatusCheckRunInput = { outcome };
      if (postedReview !== null) {
        statusCheckCompletion.summaryComment = postedReview.summaryComment;
      }
      await statusCheck.complete(statusCheckCompletion);
    } catch (error) {
      if (isReviewSupersededError(error)) {
        await statusCheck?.complete({ outcome: REVIEW_STATUS_CHECK_OUTCOMES.superseded });
        return { failedAgentCount };
      }
      const message = describeError(error);
      const markedFailed = await this.#store.markFailed(jobId, this.#now(), message);
      if (!markedFailed && (await this.#reviewWasSuperseded(jobId, cancellationSignal))) {
        await statusCheck?.complete({ outcome: REVIEW_STATUS_CHECK_OUTCOMES.superseded });
        return { failedAgentCount };
      }
      await statusCheck?.complete({ outcome: REVIEW_STATUS_CHECK_OUTCOMES.reviewFailed });
    } finally {
      for (const worktree of worktrees.reverse()) {
        await this.#cloneManager.removeWorktree(worktree);
      }
    }
    return { failedAgentCount };
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
      ...(this.#diffInspector.changedPaths === undefined
        ? {}
        : {
            changedPaths: await this.#diffInspector.changedPaths(pullRequestTarget(context)),
          }),
      productRepos: manifestRepos.map((manifestRepo) =>
        agentSelectionRepo(manifestRepo, reviewBotConfig),
      ),
    });
  }

  /**
   * Run the once-per-Review dependency install when the runner supports it.
   * Install failures degrade the Review to static analysis — loudly, via the
   * warn log here and the toolchain banner in every Agent prompt — instead of
   * failing it. Only abort/supersede propagates as a throw.
   */
  async #installWorkspaceDependencies(
    worktreePath: string,
    cacheKey: string,
    signal: AbortSignal | undefined,
  ): Promise<DependencyInstallResult | undefined> {
    const install = this.#runner.installDependencies;
    if (install === undefined) {
      return undefined;
    }

    let result: DependencyInstallResult;
    try {
      result = await install.call(this.#runner, {
        worktreePath,
        cacheKey,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (isReviewSupersededError(error) || signal?.aborted === true) {
        throw error;
      }
      result = { status: 'failed', error: describeError(error) };
    }
    if (result.status === 'failed') {
      this.#logger.warn(
        `Review dependency install failed; Agents will review statically: ${result.error}`,
      );
    }
    return result;
  }

  async #runSelectedAgents(input: {
    context: ReviewJobContext;
    agents: readonly AgentDefinition[];
    workspace: AgentWorkspace;
    manifest: ApiSurfaceManifestBuildResult | undefined;
    reviewBotConfig: ReviewBotContext;
    dependencyInstall: DependencyInstallResult | undefined;
    cancellationSignal: AbortSignal | undefined;
  }): Promise<SelectedAgentReviewResults> {
    const outputs: AgentReviewOutput[] = [];
    let failedAgentCount = 0;
    // One managed Codex auth file belongs to one execution stream. Starting
    // the timeout here also gives each Agent its full budget after the prior
    // Agent has finished, rather than consuming it while waiting for auth.
    for (const agent of input.agents) {
      const result = await this.#runSelectedAgent({ ...input, agent });
      if (result.status === 'failed') {
        failedAgentCount += 1;
        continue;
      }
      outputs.push(result.output);
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
    await this.#store.recordAgentRun(agentRunRecordInput(context.job.id, agent.key, outcome));
    if (outcome.status !== 'completed') {
      return { status: 'failed' };
    }

    return { status: 'completed', output: { agentKey: agent.key, payload: outcome.payload } };
  }

  async #executeAgent(input: AgentExecutionInput): Promise<AgentExecutionOutcome> {
    const { context, agent, cancellationSignal } = input;
    const startedAt = this.#now();
    const runInput = agentRunInput(input);
    let usage: AgentRunUsage | undefined;

    try {
      const result = await this.#runAgentWithTimeout(runInput, agent.key, cancellationSignal);
      usage = result.usage;
      await this.#throwIfCancelledOrSuperseded(context.job.id, cancellationSignal);
      const payload = parseFindingsPayload(result.stdout);
      return {
        status: 'completed',
        startedAt,
        finishedAt: this.#now(),
        payload,
        ...(usage !== undefined ? { usage } : {}),
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
        ...(usage !== undefined ? { usage } : {}),
      };
    }
  }

  async #runAgentWithTimeout(
    input: ReviewAgentRunInput,
    agentKey: string,
    parentSignal: AbortSignal | undefined,
  ): Promise<AgentRunResult> {
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
    cancellationSignal: AbortSignal | undefined,
  ): Promise<PostedSummaryComment> {
    const summaryComment = await this.#poster.postScopeDeclined({
      target,
      changedLines,
      maxChangedLines: this.#maxChangedLines,
    });
    await this.#markCompletedOrThrowIfSuperseded(jobId, cancellationSignal);
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
    testSummary: string;
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
      `${input.testSummary}\n\n${postable.summary}`,
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

  async #markCompletedOrThrowIfSuperseded(
    jobId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const markedCompleted = await this.#store.markCompleted(jobId, this.#now());
    if (markedCompleted) {
      return;
    }
    if (await this.#reviewWasSuperseded(jobId, signal)) {
      throw new ReviewSupersededError(jobId);
    }
    throw new Error(`ReviewJob ${jobId} was not running when completion was recorded`);
  }

  async #reviewWasSuperseded(jobId: string, signal: AbortSignal | undefined): Promise<boolean> {
    if (isReviewSupersededError(signal?.reason)) {
      return true;
    }
    const status = await this.#store.getReviewJobStatus(jobId);
    return status === 'superseded' || isReviewSupersededError(signal?.reason);
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
  if (input.dependencyInstall !== undefined) {
    runInput.dependencyInstall = input.dependencyInstall;
  }
  return runInput;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reviewTestSummary(result: DependencyInstallResult | undefined): string {
  if (result?.status === 'failed') {
    return 'Tests unavailable: dependency installation failed. Review used static analysis.';
  }
  if (result?.status === 'skipped') {
    return 'Tests not run: no supported project test setup.';
  }
  if (result?.status === 'installed') {
    if (result.testStatus === 'passed') return 'Tests passed: the project test suite ran once.';
    if (result.testStatus === 'failed') return 'Tests failed: the project test suite did not pass.';
    if (result.testStatus === 'skipped') return 'Tests not run: no project test script is defined.';
  }
  return 'Tests unavailable: no test-suite result was recorded.';
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
