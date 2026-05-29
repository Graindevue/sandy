import { cronJobs, type FunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api.js';
import { internalMutation } from './_generated/server.js';
import {
  REAP_STUCK_REVIEW_JOBS_BATCH_SIZE,
  STUCK_REVIEW_JOB_ERROR,
  stuckReviewJobCutoff,
} from './reviewJobReaper.js';

export const reapStuckJobs = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, { now }) => {
    const finishedAt = now ?? Date.now();
    const cutoff = stuckReviewJobCutoff(finishedAt);
    const stuckJobs = await ctx.db
      .query('reviewJobs')
      .withIndex('by_status_and_claimed_at', (q) =>
        q.eq('status', 'running').lt('claimedAt', cutoff),
      )
      .take(REAP_STUCK_REVIEW_JOBS_BATCH_SIZE);

    for (const job of stuckJobs) {
      await ctx.db.patch(job._id, {
        status: 'failed',
        finishedAt,
        error: STUCK_REVIEW_JOB_ERROR,
      });
    }

    return stuckJobs.length;
  },
});

const crons = cronJobs();

const internalRefs = internal as unknown as {
  crons: {
    reapStuckJobs: FunctionReference<'mutation'>;
  };
};

crons.interval('reap stuck ReviewJobs', { minutes: 5 }, internalRefs.crons.reapStuckJobs, {});

export default crons;
