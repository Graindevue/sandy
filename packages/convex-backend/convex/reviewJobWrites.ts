import type { ReviewTrigger, SiblingShas } from '@sandy/shared-types';
import type { Id } from './_generated/dataModel.js';
import type { MutationCtx } from './_generated/server.js';

export interface PendingReviewJobInput {
  pullRequestId: Id<'pullRequests'>;
  repoId: Id<'repos'>;
  headSha: string;
  trigger: ReviewTrigger;
  agentKeys: string[];
  siblingShas?: SiblingShas;
}

export function insertPendingReviewJob(
  ctx: MutationCtx,
  input: PendingReviewJobInput,
): Promise<Id<'reviewJobs'>> {
  return ctx.db.insert('reviewJobs', {
    pullRequestId: input.pullRequestId,
    repoId: input.repoId,
    headSha: input.headSha,
    trigger: input.trigger,
    agentKeys: input.agentKeys,
    confidenceScore: 0,
    agentRuns: [],
    siblingShas: input.siblingShas ?? {},
    status: 'pending',
  });
}
