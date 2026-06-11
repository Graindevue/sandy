import type {
  AgentDefinition,
  AgentRunUsage,
  Finding,
  ReviewJobStatus,
  SiblingShas,
} from '@sandy/shared-types';
import type {
  RecordAgentRunInput,
  RecordSynthesizedReviewInput,
  ReviewAgentRunner,
  ReviewArchetypeAssigner,
  ReviewDiffInspector,
  ReviewExecutionStore,
  ReviewJobContext,
  ReviewPoster,
} from './review-executor.js';
import type { ArchetypeAssignedFinding, PersistedFinding } from './review-findings.js';

interface RecordedFinding {
  reviewJobId: string;
  pullRequestId: string;
  finding: Finding;
}

export const logicAgent: AgentDefinition = {
  key: 'logic',
  name: 'logic',
  description: 'Reviews logic bugs.',
  category: 'logic',
  vendor: 'claude',
  model: 'opus',
  tools: [],
  maxIterations: 1,
  completionSignal: '</findings>',
  defaultEnabled: true,
  systemPrompt: 'Review logic.',
};

export const securityAgent: AgentDefinition = {
  ...logicAgent,
  key: 'security',
  name: 'security',
  description: 'Reviews security issues.',
  category: 'security',
  systemPrompt: 'Review security.',
};

export const finding: Finding = {
  severity: 'P1',
  confidence: 4,
  agentKey: 'logic',
  anchor: {
    repo: 'acme/widget',
    path: 'src/cache.ts',
    lineStart: 12,
    lineEnd: 12,
  },
  summary: 'The cache key ignores the tenant id.',
  evidence: 'The lookup only uses userId.',
  suggestedFix: 'Include tenantId.',
  category: 'logic',
};

export const securityFinding: Finding = {
  ...finding,
  agentKey: 'security',
  summary: 'The endpoint accepts an untrusted redirect target.',
  category: 'security',
};

export const skippedCrossRepoSearch = {
  status: 'skipped' as const,
  trigger: 'none' as const,
  rationale: 'No cross-repo contract risk was detected.',
};

export function makeContext(
  options: { productRepos?: ReviewJobContext['product']['repos']; agentKeys?: string[] } = {},
): ReviewJobContext {
  return {
    job: {
      id: 'job-1',
      pullRequestId: 'pr-1',
      repoId: 'repo-1',
      headSha: 'abc123',
      agentKeys: options.agentKeys ?? ['logic'],
      confidenceScore: 0,
      agentRuns: [],
    },
    repo: {
      id: 'repo-1',
      owner: 'acme',
      name: 'widget',
      defaultBranch: 'main',
    },
    product: {
      id: 'product-1',
      slug: 'acme',
      name: 'Acme',
      repos: options.productRepos ?? [
        {
          id: 'repo-1',
          owner: 'acme',
          name: 'widget',
          fullName: 'acme/widget',
          defaultBranch: 'main',
        },
      ],
    },
    pullRequest: {
      id: 'pr-1',
      number: 12,
      headSha: 'abc123',
      baseRef: 'main',
      title: 'Fix cache key',
      url: 'https://github.com/acme/widget/pull/12',
    },
  };
}

export function nextNow(values: number[]): () => number {
  const copy = [...values];
  return () => copy.shift() ?? values.at(-1) ?? 0;
}

export function findingsOutput(findings: Finding[], summary?: string): string {
  const payload: {
    findings: Finding[];
    crossRepoSearch: typeof skippedCrossRepoSearch;
    summary?: string;
  } = {
    findings,
    crossRepoSearch: skippedCrossRepoSearch,
  };
  if (summary !== undefined) {
    payload.summary = summary;
  }
  return `<findings>${JSON.stringify(payload)}</findings>`;
}

export class FakeExecutionStore implements ReviewExecutionStore {
  recordedManifests: Array<{
    productId: string;
    repoShas: { repo: string; sha: string }[];
    markdown: string;
    builtAt: number;
  }> = [];
  recordedSiblingShas: { jobId: string; siblingShas: SiblingShas }[] = [];
  confidenceScores: { jobId: string; confidenceScore: Finding['confidence'] }[] = [];
  recordedFindings: RecordedFinding[] = [];
  postedFindings: { findingId: string; githubCommentId: number }[] = [];
  agentRuns: RecordAgentRunInput[] = [];
  checkRunIds: { jobId: string; checkRunId: number }[] = [];
  completed: { jobId: string; finishedAt: number }[] = [];
  failed: { jobId: string; finishedAt: number; error: string }[] = [];
  status: ReviewJobStatus | null = 'running';

  constructor(private readonly context: ReviewJobContext | null) {}

  async getReviewJobContext(_jobId: string): Promise<ReviewJobContext | null> {
    return this.context;
  }

  async getReviewJobStatus(_jobId: string): Promise<typeof this.status> {
    return this.status;
  }

  async recordApiSurfaceManifest(input: {
    productId: string;
    repoShas: { repo: string; sha: string }[];
    markdown: string;
    builtAt: number;
  }): Promise<void> {
    this.recordedManifests.push(input);
  }

  async recordSiblingShas(jobId: string, siblingShas: SiblingShas): Promise<void> {
    this.recordedSiblingShas.push({ jobId, siblingShas });
  }

  async recordSynthesizedReview(input: RecordSynthesizedReviewInput): Promise<PersistedFinding[]> {
    this.confidenceScores.push({
      jobId: input.reviewJobId,
      confidenceScore: input.confidenceScore,
    });
    return input.findings.map((persistedFinding) => {
      this.recordedFindings.push({
        reviewJobId: input.reviewJobId,
        pullRequestId: input.pullRequestId,
        finding: persistedFinding,
      });
      return { id: `finding-${this.recordedFindings.length}`, finding: persistedFinding };
    });
  }

  async markFindingPosted(findingId: string, githubCommentId: number): Promise<void> {
    this.postedFindings.push({ findingId, githubCommentId });
  }

  async recordAgentRun(input: RecordAgentRunInput): Promise<void> {
    this.agentRuns.push(input);
  }

  async setReviewCheckRunId(jobId: string, checkRunId: number): Promise<void> {
    this.checkRunIds.push({ jobId, checkRunId });
  }

  async markCompleted(jobId: string, finishedAt: number): Promise<boolean> {
    if (this.status !== 'running') {
      return false;
    }
    this.status = 'completed';
    this.completed.push({ jobId, finishedAt });
    return true;
  }

  async markFailed(jobId: string, finishedAt: number, error: string): Promise<boolean> {
    if (this.status !== 'running') {
      return false;
    }
    this.status = 'failed';
    this.failed.push({ jobId, finishedAt, error });
    return true;
  }
}

export class FakeArchetypeAssigner implements ReviewArchetypeAssigner {
  constructor(private readonly suppressionWeights: readonly number[] = []) {}

  async assignArchetypes(
    findings: readonly PersistedFinding[],
  ): Promise<ArchetypeAssignedFinding[]> {
    return findings.map((persistedFinding, index) => ({
      ...persistedFinding,
      archetypeId: `archetype-${index + 1}`,
      archetypeSuppressionWeight: this.suppressionWeights[index] ?? 0,
    }));
  }
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeCloneManager {
  ensured: unknown[] = [];
  created: unknown[] = [];
  defaultBranchResolutions: unknown[] = [];
  defaultBranchShas = new Map<string, string>();
  removed: string[] = [];

  async ensureCloned(repo: { owner: string; name: string; defaultBranch: string }): Promise<void> {
    this.ensured.push(repo);
  }

  async resolveDefaultBranchSha(repo: { owner: string; name: string }): Promise<string> {
    this.defaultBranchResolutions.push(repo);
    return this.defaultBranchShas.get(`${repo.owner}/${repo.name}`) ?? 'default-sha';
  }

  async createWorktree(
    repo: { owner: string; name: string; defaultBranch: string },
    request: { reviewJobId: string; sha: string },
  ): Promise<{
    repo: { owner: string; name: string; defaultBranch: string };
    reviewJobId: string;
    path: string;
    sha: string;
  }> {
    this.created.push({ repo, request });
    return {
      repo,
      reviewJobId: request.reviewJobId,
      sha: request.sha,
      path: `/tmp/worktree/${repo.owner}/${repo.name}/${request.reviewJobId}`,
    };
  }

  async removeWorktree(worktree: {
    repo: { owner: string; name: string };
    reviewJobId: string;
  }): Promise<void> {
    this.removed.push(`${worktree.repo.owner}/${worktree.repo.name}@${worktree.reviewJobId}`);
  }
}

export class FakePoster implements ReviewPoster {
  results: Array<Parameters<ReviewPoster['postReviewResult']>[0]> = [];
  scopeDeclines: { changedLines: number; maxChangedLines: number }[] = [];

  async postReviewResult(
    input: Parameters<ReviewPoster['postReviewResult']>[0],
  ): ReturnType<ReviewPoster['postReviewResult']> {
    this.results.push(input);
    return {
      postedFindings: input.findings.map((postableFinding, index) => ({
        findingId: postableFinding.id,
        commentId: 900 + index,
      })),
      summaryComment: {
        commentId: 900,
        url: 'https://github.com/acme/widget/pull/12#issuecomment-900',
      },
    };
  }

  async postScopeDeclined(
    input: Parameters<ReviewPoster['postScopeDeclined']>[0],
  ): ReturnType<ReviewPoster['postScopeDeclined']> {
    this.scopeDeclines.push({
      changedLines: input.changedLines,
      maxChangedLines: input.maxChangedLines,
    });
    return {
      commentId: 900,
      url: 'https://github.com/acme/widget/pull/12#issuecomment-900',
    };
  }
}

export class FakeDiffInspector implements ReviewDiffInspector {
  calls: {
    target: Parameters<ReviewDiffInspector['changedLineCount']>[0];
    ignorePatterns: Parameters<ReviewDiffInspector['changedLineCount']>[1];
  }[] = [];

  constructor(private readonly changedLines: number) {}

  async changedLineCount(
    target: Parameters<ReviewDiffInspector['changedLineCount']>[0],
    ignorePatterns?: Parameters<ReviewDiffInspector['changedLineCount']>[1],
  ): Promise<number> {
    this.calls.push({ target, ignorePatterns });
    return this.changedLines;
  }
}

export class FakeRunner implements ReviewAgentRunner {
  calls: Array<Parameters<ReviewAgentRunner['runAgent']>[0]> = [];

  constructor(
    private readonly stdout: string,
    private readonly usage?: AgentRunUsage,
  ) {}

  async runAgent(input: Parameters<ReviewAgentRunner['runAgent']>[0]) {
    this.calls.push(input);
    return {
      stdout: this.stdout,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    };
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}
