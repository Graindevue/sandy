import type { AgentDefinition, AgentRunStatus, Finding } from '@sandy/shared-types';
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
  }): Promise<string>;
}

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

export interface ReviewExecutorOptions {
  store: ReviewExecutionStore;
  cloneManager: ReviewCloneManager;
  diffInspector: ReviewDiffInspector;
  runner: ReviewAgentRunner;
  poster: ReviewPoster;
  resolveAgent(repo: RepoForWorktree, agentKey: string): AgentDefinition | null;
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
  readonly #maxChangedLines: number;
  readonly #now: () => number;

  constructor(options: ReviewExecutorOptions) {
    this.#store = options.store;
    this.#cloneManager = options.cloneManager;
    this.#diffInspector = options.diffInspector;
    this.#runner = options.runner;
    this.#poster = options.poster;
    this.#resolveAgent = options.resolveAgent;
    this.#maxChangedLines = options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
    this.#now = options.now ?? Date.now;
  }

  async executeClaimedJob(jobId: string): Promise<void> {
    let context: ReviewJobContext | null = null;
    let worktree: ReviewWorktree | null = null;
    let agentKey: string | null = null;
    let agentStartedAt: number | null = null;
    let agentRunRecorded = false;

    try {
      context = await this.#requiredContext(jobId);
      agentKey = requireLogicAgentKey(context);
      const repo = repoForWorktree(context);
      const agent = this.#requiredAgent(repo, agentKey);
      const target = pullRequestTarget(context);
      const changedLines = await this.#diffInspector.changedLineCount(target);

      if (changedLines > this.#maxChangedLines) {
        await this.#poster.postScopeDeclined({
          target,
          changedLines,
          maxChangedLines: this.#maxChangedLines,
        });
        await this.#store.markCompleted(jobId, this.#now());
        return;
      }

      await this.#cloneManager.ensureCloned(repo);
      worktree = await this.#cloneManager.createWorktree(repo, {
        reviewJobId: context.job.id,
        sha: context.job.headSha,
      });

      agentStartedAt = this.#now();
      const stdout = await this.#runner.runLogicAgent({
        agent,
        worktreePath: worktree.path,
        pullRequest: runnerPullRequest(context),
      });
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

      const persistedFindings: PersistedFinding[] = [];
      for (const finding of payload.findings) {
        const id = await this.#store.recordFinding({
          reviewJobId: context.job.id,
          pullRequestId: context.pullRequest.id,
          agentKey,
          finding,
        });
        persistedFindings.push({ id, finding });
      }

      const postInput: {
        target: PullRequestTarget;
        agentKey: string;
        findings: PersistedFinding[];
        summary?: string;
      } = {
        target,
        agentKey,
        findings: persistedFindings,
      };
      if (payload.summary !== undefined) {
        postInput.summary = payload.summary;
      }
      const posted = await this.#poster.postReviewResult(postInput);
      for (const postedFinding of posted) {
        await this.#store.markFindingPosted(postedFinding.findingId, postedFinding.commentId);
      }

      await this.#store.markCompleted(jobId, this.#now());
    } catch (error) {
      const message = describeError(error);
      if (context !== null && agentKey !== null && agentStartedAt !== null && !agentRunRecorded) {
        await this.#store.recordAgentRun({
          reviewJobId: context.job.id,
          agentKey,
          status: 'failed',
          startedAt: agentStartedAt,
          finishedAt: this.#now(),
          findingCount: 0,
          error: message,
        });
      }
      await this.#store.markFailed(jobId, this.#now(), message);
    } finally {
      if (worktree !== null) {
        await this.#cloneManager.removeWorktree(worktree);
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
}

function requireLogicAgentKey(context: ReviewJobContext): string {
  if (context.job.agentKeys.length !== 1 || context.job.agentKeys[0] !== 'logic') {
    throw new Error(
      `Phase 1 can only execute the logic Agent, got ${context.job.agentKeys.join(', ')}`,
    );
  }
  return 'logic';
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
