import { api } from '@sandy/convex-backend/api';
import type { ReviewTrigger } from '@sandy/shared-types';
import type { ConvexHttpClient } from 'convex/browser';
import type {
  MergeStateReactionKind,
  MergeStateStore,
  MergeStateTarget,
} from '../learning/merge-state-inferrer.js';
import type {
  ReactionCaptureStore,
  ReactionTarget,
  RecordedReactionInput,
} from '../learning/reaction-capture.js';
import type { RepoRef } from './events.js';

/**
 * The Convex side effects the dispatcher needs, as an interface rather than a
 * concrete client, so the dispatcher unit-tests against an in-memory fake and
 * never touches a real deployment. {@link ConvexSink} is the production
 * implementation over `ConvexHttpClient` + the generated `api`.
 */
export interface ReviewSink {
  /** Resolve `owner/name` to a Convex Repo id, provisioning it on first sight. */
  ensureRepo(repo: RepoRef, defaultBranch: string | undefined): Promise<string>;
  /** The PR's current Sticky Opt-In flag, or `false` if Sandy hasn't seen it. */
  getReviewActive(repoId: string, number: number): Promise<boolean>;
  /** Upsert the PullRequest row and return its id. */
  upsertPullRequest(input: UpsertPullRequestInput): Promise<string>;
  /** Flip the Sticky Opt-In flag. */
  setReviewActive(pullRequestId: string, active: boolean): Promise<void>;
  /** Clear the Sticky Opt-In flag after a PR closes. */
  clearOnClose(pullRequestId: string): Promise<void>;
  /** Enqueue a pending ReviewJob and return its id. */
  enqueueReviewJob(input: EnqueueInput): Promise<string>;
  /**
   * For a new push head, supersede active stale ReviewJobs and enqueue (or reuse)
   * the pending/running job for the new head in one Convex transaction.
   */
  enqueueSupersedingReviewJob(input: EnqueueInput): Promise<EnqueueSupersedingResult>;
}

export interface UpsertPullRequestInput {
  repoId: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headSha: string;
  baseRef: string;
  title: string;
  author: string;
  url: string;
}

export interface EnqueueInput {
  pullRequestId: string;
  repoId: string;
  headSha: string;
  trigger: ReviewTrigger;
  agentKeys: string[];
}

export interface EnqueueSupersedingResult {
  reviewJobId: string;
  supersededJobIds: string[];
  enqueued: boolean;
}

/**
 * Production {@link ReviewSink} backed by `ConvexHttpClient` and the generated
 * `api`. The Convex document ids round-trip through Sandy as opaque strings;
 * the `as never` casts re-brand them to the generated `Id<…>` types the API
 * expects (a Convex client convention — runtime ids are plain strings).
 */
export class ConvexSink implements ReviewSink, ReactionCaptureStore, MergeStateStore {
  readonly #client: ConvexHttpClient;

  constructor(client: ConvexHttpClient) {
    this.#client = client;
  }

  async ensureRepo(repo: RepoRef, defaultBranch: string | undefined): Promise<string> {
    return await this.#client.mutation(
      api.pullRequests.ensureRepo,
      defaultBranch === undefined
        ? { owner: repo.owner, name: repo.name }
        : { owner: repo.owner, name: repo.name, defaultBranch },
    );
  }

  async getReviewActive(repoId: string, number: number): Promise<boolean> {
    const pr = await this.#client.query(api.pullRequests.get, {
      repoId: repoId as never,
      number,
    });
    return pr?.reviewActive ?? false;
  }

  async upsertPullRequest(input: UpsertPullRequestInput): Promise<string> {
    return await this.#client.mutation(api.pullRequests.upsert, {
      repoId: input.repoId as never,
      number: input.number,
      state: input.state,
      draft: input.draft,
      headSha: input.headSha,
      baseRef: input.baseRef,
      title: input.title,
      author: input.author,
      url: input.url,
    });
  }

  async setReviewActive(pullRequestId: string, active: boolean): Promise<void> {
    await this.#client.mutation(api.pullRequests.setReviewActive, {
      pullRequestId: pullRequestId as never,
      active,
    });
  }

  async clearOnClose(pullRequestId: string): Promise<void> {
    await this.#client.mutation(api.pullRequests.clearOnClose, {
      pullRequestId: pullRequestId as never,
    });
  }

  async enqueueReviewJob(input: EnqueueInput): Promise<string> {
    return await this.#client.mutation(api.reviewJobs.enqueue, {
      pullRequestId: input.pullRequestId as never,
      repoId: input.repoId as never,
      headSha: input.headSha,
      trigger: input.trigger,
      agentKeys: input.agentKeys,
    });
  }

  async enqueueSupersedingReviewJob(input: EnqueueInput): Promise<EnqueueSupersedingResult> {
    return (await this.#client.mutation(api.reviewJobs.enqueueSuperseding, {
      pullRequestId: input.pullRequestId as never,
      repoId: input.repoId as never,
      headSha: input.headSha,
      trigger: input.trigger,
      agentKeys: input.agentKeys,
      supersededAt: Date.now(),
    })) as EnqueueSupersedingResult;
  }

  async listReactionTargetsForPr(pullRequestId: string): Promise<ReactionTarget[]> {
    const findings = await this.#client.query(api.findings.listForPr, {
      pullRequestId: pullRequestId as never,
    });
    return findings.map(findingCommentTarget);
  }

  async recordReaction(input: RecordedReactionInput): Promise<void> {
    const findingId = input.findingId as never;
    if (input.kind === 'reply') {
      await this.#client.mutation(api.reactions.recordReaction, {
        findingId,
        kind: input.kind,
        replyText: input.replyText,
      });
      return;
    }
    await this.#client.mutation(api.reactions.recordReaction, { findingId, kind: input.kind });
  }

  async listMergeStateTargetsForPr(pullRequestId: string): Promise<MergeStateTarget[]> {
    const findings = await this.#client.query(api.findings.listForPr, {
      pullRequestId: pullRequestId as never,
    });
    return findings.map((finding) => ({
      ...findingCommentTarget(finding),
      anchor: finding.anchor,
    }));
  }

  async recordMergeStateReaction(input: {
    findingId: string;
    kind: MergeStateReactionKind;
  }): Promise<boolean> {
    return await this.#client.mutation(api.reactions.recordMergeStateReaction, {
      findingId: input.findingId as never,
      kind: input.kind,
    });
  }

  async listMergedPullRequestsForMergeStateBackfill(
    limit: number,
  ): Promise<Array<{ pullRequestId: string; repo: RepoRef; pullNumber: number }>> {
    return await this.#client.query(api.pullRequests.listMergedForMergeStateBackfill, { limit });
  }

  async markMergeStateSignalsRolledUp(input: {
    pullRequestId: string;
    rolledUpAt: number;
  }): Promise<void> {
    await this.#client.mutation(api.pullRequests.markMergeStateSignalsRolledUp, {
      pullRequestId: input.pullRequestId as never,
      rolledUpAt: input.rolledUpAt,
    });
  }
}

function findingCommentTarget(finding: { _id: string; githubCommentId?: number }): ReactionTarget {
  return finding.githubCommentId === undefined
    ? { findingId: finding._id }
    : { findingId: finding._id, githubCommentId: finding.githubCommentId };
}
