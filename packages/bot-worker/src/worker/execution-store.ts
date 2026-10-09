import { api } from '@sandy/convex-backend/api';
import type { Finding, ReviewJobStatus, SiblingShas } from '@sandy/shared-types';
import type { FunctionReference } from 'convex/server';
import type {
  RecordAgentRunInput,
  RecordSynthesizedReviewInput,
  ReviewExecutionStore,
  ReviewJobContext,
} from './review-executor.js';
import type { PersistedFinding } from './review-findings.js';

type QueryRef = FunctionReference<'query'>;
type MutationRef = FunctionReference<'mutation'>;
type ActionRef = FunctionReference<'action'>;

export interface ConvexExecutionClient {
  query(query: QueryRef, args: Record<string, unknown>): Promise<unknown>;
  mutation(mutation: MutationRef, args: Record<string, unknown>): Promise<unknown>;
  action(action: ActionRef, args: Record<string, unknown>): Promise<unknown>;
}

interface RecordFindingInput {
  reviewJobId: string;
  pullRequestId: string;
  finding: Finding;
}

const refs = {
  reviewJobs: {
    getForWorker: api.reviewJobs.getForWorker,
    getStatus: api.reviewJobs.getStatus,
    setSiblingShas: api.reviewJobs.setSiblingShas,
    setCheckRunId: api.reviewJobs.setCheckRunId,
    markCompleted: api.reviewJobs.markCompleted,
    markFailed: api.reviewJobs.markFailed,
  },
  findings: {
    recordFinding: api.findings.recordFinding,
    recordSynthesizedReview: api.findings.recordSynthesizedReview,
    markPosted: api.findings.markPosted,
  },
  archetypes: {
    assignOrCreateArchetype: api.archetypes.assignOrCreateArchetype,
  },
  agentRuns: {
    record: api.agentRuns.record,
  },
  apiSurfaceManifests: {
    record: api.apiSurfaceManifests.record,
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
    return (await this.#client.mutation(refs.findings.recordFinding, {
      reviewJobId: input.reviewJobId,
      pullRequestId: input.pullRequestId,
      ...findingMutationArgs(input.finding),
    })) as string;
  }

  async recordSynthesizedReview(input: RecordSynthesizedReviewInput): Promise<PersistedFinding[]> {
    const findingIds = (await this.#client.mutation(refs.findings.recordSynthesizedReview, {
      reviewJobId: input.reviewJobId,
      pullRequestId: input.pullRequestId,
      confidenceScore: input.confidenceScore,
      findings: input.findings.map(findingMutationArgs),
    })) as string[];

    return input.findings.map((finding, index) => {
      const id = findingIds[index];
      if (id === undefined) {
        throw new Error('Convex did not return an id for every synthesized Finding');
      }
      return { id, finding };
    });
  }

  async markFindingPosted(findingId: string, githubCommentId: number): Promise<void> {
    await this.#client.mutation(refs.findings.markPosted, { findingId, githubCommentId });
  }

  async assignArchetype(input: {
    findingId: string;
    embedding: number[];
  }): Promise<{ archetypeId: string; suppressionWeight: number }> {
    return (await this.#client.action(refs.archetypes.assignOrCreateArchetype, input)) as {
      archetypeId: string;
      suppressionWeight: number;
    };
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
    if (input.usage !== undefined) {
      args.usage = input.usage;
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

  async setReviewCheckRunId(jobId: string, checkRunId: number): Promise<void> {
    await this.#client.mutation(refs.reviewJobs.setCheckRunId, { jobId, checkRunId });
  }

  async markCompleted(jobId: string, finishedAt: number): Promise<boolean> {
    return booleanMutationResult(
      await this.#client.mutation(refs.reviewJobs.markCompleted, { jobId, finishedAt }),
      'reviewJobs.markCompleted',
    );
  }

  async markFailed(jobId: string, finishedAt: number, error: string): Promise<boolean> {
    return booleanMutationResult(
      await this.#client.mutation(refs.reviewJobs.markFailed, { jobId, finishedAt, error }),
      'reviewJobs.markFailed',
    );
  }
}

function booleanMutationResult(value: unknown, name: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Convex mutation ${name} did not return a boolean`);
}

function findingMutationArgs(finding: Finding): Record<string, unknown> {
  const args: Record<string, unknown> = {
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
  return args;
}
