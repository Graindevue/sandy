import type { ReviewJobStatus, SiblingShas } from '@sandy/shared-types';
import { type FunctionReference, makeFunctionReference } from 'convex/server';
import type {
  RecordAgentRunInput,
  RecordFindingInput,
  ReviewExecutionStore,
  ReviewJobContext,
} from './review-executor.js';

type QueryRef = FunctionReference<'query'>;
type MutationRef = FunctionReference<'mutation'>;

export interface ConvexExecutionClient {
  query(query: QueryRef, args: Record<string, unknown>): Promise<unknown>;
  mutation(mutation: MutationRef, args: Record<string, unknown>): Promise<unknown>;
}

const refs = {
  reviewJobs: {
    getForWorker: makeFunctionReference<'query'>('reviewJobs:getForWorker'),
    getStatus: makeFunctionReference<'query'>('reviewJobs:getStatus'),
    setSiblingShas: makeFunctionReference<'mutation'>('reviewJobs:setSiblingShas'),
    markCompleted: makeFunctionReference<'mutation'>('reviewJobs:markCompleted'),
    markFailed: makeFunctionReference<'mutation'>('reviewJobs:markFailed'),
  },
  findings: {
    recordFinding: makeFunctionReference<'mutation'>('findings:recordFinding'),
    markPosted: makeFunctionReference<'mutation'>('findings:markPosted'),
  },
  agentRuns: {
    record: makeFunctionReference<'mutation'>('agentRuns:record'),
  },
  apiSurfaceManifests: {
    record: makeFunctionReference<'mutation'>('apiSurfaceManifests:record'),
  },
};

export class ConvexExecutionStore implements ReviewExecutionStore {
  readonly #client: ConvexExecutionClient;

  constructor(client: ConvexExecutionClient) {
    this.#client = client;
  }

  async getReviewJobContext(jobId: string): Promise<ReviewJobContext | null> {
    return (await this.#client.query(refs.reviewJobs.getForWorker, {
      jobId,
    })) as ReviewJobContext | null;
  }

  async getReviewJobStatus(jobId: string): Promise<ReviewJobStatus | null> {
    return (await this.#client.query(refs.reviewJobs.getStatus, {
      jobId,
    })) as ReviewJobStatus | null;
  }

  async recordFinding(input: RecordFindingInput): Promise<string> {
    const { finding } = input;
    const args: Record<string, unknown> = {
      reviewJobId: input.reviewJobId,
      pullRequestId: input.pullRequestId,
      agentKey: finding.agentKey,
      severity: finding.severity,
      confidence: finding.confidence,
      anchor: finding.anchor,
      summary: finding.summary,
      evidence: finding.evidence,
      category: finding.category,
    };
    if (finding.crossRepoReferences !== undefined) {
      args.crossRepoReferences = finding.crossRepoReferences;
    }
    if (finding.suggestedFix !== undefined) {
      args.suggestedFix = finding.suggestedFix;
    }
    return (await this.#client.mutation(refs.findings.recordFinding, args)) as string;
  }

  async markFindingPosted(findingId: string, githubCommentId: number): Promise<void> {
    await this.#client.mutation(refs.findings.markPosted, { findingId, githubCommentId });
  }

  async recordAgentRun(input: RecordAgentRunInput): Promise<void> {
    const args: Record<string, unknown> = {
      reviewJobId: input.reviewJobId,
      agentKey: input.agentKey,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      findingCount: input.findingCount,
    };
    if (input.error !== undefined) {
      args.error = input.error;
    }
    if (input.crossRepoSearch !== undefined) {
      args.crossRepoSearch = input.crossRepoSearch;
    }
    await this.#client.mutation(refs.agentRuns.record, args);
  }

  async recordApiSurfaceManifest(input: {
    productId: string;
    repoShas: { repo: string; sha: string }[];
    markdown: string;
    builtAt: number;
  }): Promise<void> {
    await this.#client.mutation(refs.apiSurfaceManifests.record, input);
  }

  async recordSiblingShas(jobId: string, siblingShas: SiblingShas): Promise<void> {
    await this.#client.mutation(refs.reviewJobs.setSiblingShas, { jobId, siblingShas });
  }

  async markCompleted(jobId: string, finishedAt: number): Promise<void> {
    await this.#client.mutation(refs.reviewJobs.markCompleted, { jobId, finishedAt });
  }

  async markFailed(jobId: string, finishedAt: number, error: string): Promise<void> {
    await this.#client.mutation(refs.reviewJobs.markFailed, { jobId, finishedAt, error });
  }
}
