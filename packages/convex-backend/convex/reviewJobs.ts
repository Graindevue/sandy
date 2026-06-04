import type { ReviewJobStatus } from '@sandy/shared-types';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel.js';
import { mutation, query } from './_generated/server.js';
import { insertPendingReviewJob } from './reviewJobWrites.js';
import { confidence, reviewJobStatus, reviewTrigger, siblingShas } from './validators.js';

const ACTIVE_REVIEW_JOB_STATUSES = [
  'pending',
  'running',
] as const satisfies readonly ReviewJobStatus[];

/** Enqueue a new `pending` ReviewJob and return its id. */
export const enqueue = mutation({
  args: {
    pullRequestId: v.id('pullRequests'),
    repoId: v.id('repos'),
    headSha: v.string(),
    trigger: reviewTrigger,
    agentKeys: v.array(v.string()),
    siblingShas: v.optional(siblingShas),
  },
  returns: v.id('reviewJobs'),
  handler: async (ctx, args) => {
    return await insertPendingReviewJob(ctx, args);
  },
});

/**
 * Push-triggered enqueue with Cancel-on-Supersede semantics. In one transaction:
 * mark pending/running jobs for older heads as `superseded`, then enqueue the
 * new head unless a pending/running job for that same head already exists
 * (covers GitHub delivering both `push` and `pull_request.synchronize`).
 */
export const enqueueSuperseding = mutation({
  args: {
    pullRequestId: v.id('pullRequests'),
    repoId: v.id('repos'),
    headSha: v.string(),
    trigger: reviewTrigger,
    agentKeys: v.array(v.string()),
    siblingShas: v.optional(siblingShas),
    supersededAt: v.number(),
  },
  returns: v.object({
    reviewJobId: v.id('reviewJobs'),
    supersededJobIds: v.array(v.id('reviewJobs')),
    enqueued: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const supersededJobIds: Array<Id<'reviewJobs'>> = [];
    let existingSameHeadJobId: Id<'reviewJobs'> | null = null;

    for (const status of ACTIVE_REVIEW_JOB_STATUSES) {
      const activeJobs = ctx.db
        .query('reviewJobs')
        .withIndex('by_pull_request_and_status', (q) =>
          q.eq('pullRequestId', args.pullRequestId).eq('status', status),
        );

      for await (const job of activeJobs) {
        if (job.headSha === args.headSha) {
          existingSameHeadJobId ??= job._id;
          continue;
        }
        await ctx.db.patch(job._id, { status: 'superseded', finishedAt: args.supersededAt });
        supersededJobIds.push(job._id);
      }
    }

    if (existingSameHeadJobId !== null) {
      return { reviewJobId: existingSameHeadJobId, supersededJobIds, enqueued: false };
    }

    const reviewJobId = await insertPendingReviewJob(ctx, args);
    return { reviewJobId, supersededJobIds, enqueued: true };
  },
});

/** Record the sibling default-branch SHAs pinned for this ReviewJob. */
export const setSiblingShas = mutation({
  args: { jobId: v.id('reviewJobs'), siblingShas },
  returns: v.null(),
  handler: async (ctx, { jobId, siblingShas }) => {
    await ctx.db.patch(jobId, { siblingShas });
    return null;
  },
});

/** Persist the GitHub Check Run id created for this ReviewJob. */
export const setCheckRunId = mutation({
  args: { jobId: v.id('reviewJobs'), checkRunId: v.number() },
  returns: v.null(),
  handler: async (ctx, { jobId, checkRunId }) => {
    await ctx.db.patch(jobId, { checkRunId });
    return null;
  },
});

/** Store the synthesized PR-level confidence score for this ReviewJob. */
export const setConfidenceScore = mutation({
  args: { jobId: v.id('reviewJobs'), confidenceScore: confidence },
  returns: v.null(),
  handler: async (ctx, { jobId, confidenceScore }) => {
    await ctx.db.patch(jobId, { confidenceScore });
    return null;
  },
});

/**
 * All currently `pending` ReviewJobs. The worker reactively subscribes to this
 * query and races to `claim` each one.
 */
export const subscribePending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query('reviewJobs')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .collect();
  },
});

/** Hydrate one claimed ReviewJob with the Repo and PullRequest data the worker needs. */
export const getForWorker = query({
  args: { jobId: v.id('reviewJobs') },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (job === null) {
      return null;
    }
    const [repo, pullRequest] = await Promise.all([
      ctx.db.get(job.repoId),
      ctx.db.get(job.pullRequestId),
    ]);
    if (repo === null || pullRequest === null) {
      return null;
    }
    const product = await ctx.db.get(repo.productId);
    if (product === null) {
      return null;
    }
    const productRepos = await ctx.db
      .query('repos')
      .withIndex('by_product', (q) => q.eq('productId', repo.productId))
      .collect();
    return {
      job: {
        id: job._id,
        pullRequestId: job.pullRequestId,
        repoId: job.repoId,
        headSha: job.headSha,
        agentKeys: job.agentKeys,
        confidenceScore: job.confidenceScore,
        agentRuns: job.agentRuns,
        siblingShas: job.siblingShas,
        checkRunId: job.checkRunId,
      },
      repo: {
        id: repo._id,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      },
      product: {
        id: product._id,
        slug: product.slug,
        name: product.name,
        repos: productRepos.map((productRepo) => ({
          id: productRepo._id,
          owner: productRepo.owner,
          name: productRepo.name,
          fullName: productRepo.fullName,
          defaultBranch: productRepo.defaultBranch,
        })),
      },
      pullRequest: {
        id: pullRequest._id,
        number: pullRequest.number,
        headSha: pullRequest.headSha,
        baseRef: pullRequest.baseRef,
        title: pullRequest.title,
        url: pullRequest.url,
      },
    };
  },
});

/** Current status for a worker-side stale-result check before posting comments. */
export const getStatus = query({
  args: { jobId: v.id('reviewJobs') },
  returns: v.union(reviewJobStatus, v.null()),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    return job?.status ?? null;
  },
});

/**
 * Claim a `pending` job, transitioning it to `running`. OCC-protected: Convex
 * runs each mutation as a serializable transaction and retries on write
 * conflict, so when two workers race the same job exactly one observes
 * `pending` and wins; the other re-runs, sees `running`, and returns `false`.
 */
export const claim = mutation({
  args: { jobId: v.id('reviewJobs'), claimedAt: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { jobId, claimedAt }) => {
    const job = await ctx.db.get(jobId);
    if (job === null || job.status !== 'pending') {
      return false;
    }
    await ctx.db.patch(jobId, { status: 'running', claimedAt });
    return true;
  },
});

/**
 * Mark a `running` job `completed`. Guarded like `claim`/`markSuperseded`: only
 * a job still `running` transitions, so a worker finishing after its job was
 * superseded can't clobber the `superseded` outcome. Returns whether it did.
 */
export const markCompleted = mutation({
  args: { jobId: v.id('reviewJobs'), finishedAt: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { jobId, finishedAt }) => {
    const job = await ctx.db.get(jobId);
    if (job === null || job.status !== 'running') {
      return false;
    }
    await ctx.db.patch(jobId, { status: 'completed', finishedAt });
    return true;
  },
});

/**
 * Mark a `running` job `failed` with a reason. Guarded like `markCompleted`, so
 * a late failure can't overwrite a `superseded` outcome. Returns whether it did.
 */
export const markFailed = mutation({
  args: { jobId: v.id('reviewJobs'), finishedAt: v.number(), error: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { jobId, finishedAt, error }) => {
    const job = await ctx.db.get(jobId);
    if (job === null || job.status !== 'running') {
      return false;
    }
    await ctx.db.patch(jobId, { status: 'failed', finishedAt, error });
    return true;
  },
});

/**
 * Mark a job `superseded` — a newer push arrived during an in-flight Review.
 * Only transitions jobs still `pending` or `running`; returns whether it did.
 */
export const markSuperseded = mutation({
  args: { jobId: v.id('reviewJobs'), finishedAt: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { jobId, finishedAt }) => {
    const job = await ctx.db.get(jobId);
    if (job === null || (job.status !== 'pending' && job.status !== 'running')) {
      return false;
    }
    await ctx.db.patch(jobId, { status: 'superseded', finishedAt });
    return true;
  },
});
