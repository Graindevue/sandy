import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { reviewTrigger } from './validators';

/** Enqueue a new `pending` ReviewJob and return its id. */
export const enqueue = mutation({
  args: {
    pullRequestId: v.id('pullRequests'),
    repoId: v.id('repos'),
    headSha: v.string(),
    trigger: reviewTrigger,
    agentKeys: v.array(v.string()),
  },
  returns: v.id('reviewJobs'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('reviewJobs', { ...args, status: 'pending' });
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
