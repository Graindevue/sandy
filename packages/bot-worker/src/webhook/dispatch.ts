import type { ReviewTrigger } from '@sandy/shared-types';
import type { ReviewCanceller } from '../worker/cancellation.js';
import type { ParsedEvent, PullRequestFacts, RepoRef } from './events.js';
import { prStateForEvent } from './parse.js';
import type { ReviewSink } from './sink.js';
import { evaluateTrigger } from './trigger-evaluator.js';

/** The message Sandy surfaces when it declines a fork PR (PRD documented limitation). */
export const FORK_DECLINE_MESSAGE =
  'Sandy does not review pull requests from forked repositories yet: the head commit ' +
  'lives in a different repository, which this version cannot fetch securely. This is a ' +
  'documented v1 limitation and is planned for a later phase.';

/** What the dispatcher decided to do with one delivery. Returned for logging/tests. */
export type DispatchOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'cleared'; pullRequestId: string }
  | { action: 'declined-fork'; repo: string; number: number }
  | {
      action: 'enqueued';
      reviewJobId: string;
      trigger: ReviewTrigger;
      supersededJobIds?: string[];
    }
  | { action: 'noop'; reason: string };

/** A minimal logger; the server passes `console`, tests pass a spy or a no-op. */
export interface DispatchLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface ForkDeclineCommenter {
  postForkDeclined(input: { repo: RepoRef; pullNumber: number; body: string }): Promise<void>;
}

export interface DispatchOptions {
  forkDeclineCommenter?: ForkDeclineCommenter;
  reviewCanceller?: ReviewCanceller;
}

function fullName(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * Apply Sticky Opt-In to one normalized webhook event, performing the resulting
 * Convex side effects through {@link ReviewSink}. The decision is made by the
 * pure {@link evaluateTrigger}; this function owns only the ordering of effects:
 *
 *   1. resolve the Repo (auto-provision on first sight — TODO(#5)),
 *   2. read the PR's current `reviewActive`,
 *   3. upsert the PR,
 *   4. flip / clear the flag, then enqueue — so an enqueued job always points at
 *      a PR row whose flag already reflects the opt-in.
 *
 * Push-triggered reviews use a single Convex mutation that supersedes active
 * stale jobs and enqueues (or reuses) the new-head job atomically; any local
 * running jobs returned by that mutation are then aborted through the optional
 * cancellation registry.
 */
export async function dispatchEvent(
  event: ParsedEvent,
  sink: ReviewSink,
  logger: DispatchLogger,
  options: DispatchOptions = {},
): Promise<DispatchOutcome> {
  if (event.kind === 'ignored') {
    logger.info(`webhook ignored: ${event.reason}`);
    return { action: 'ignored', reason: event.reason };
  }

  const { repo, pr } = event;
  const repoId = await sink.ensureRepo(repo, undefined);
  const currentReviewActive = await sink.getReviewActive(repoId, pr.number);

  const decision = evaluateTrigger(event, currentReviewActive);

  if (decision.decline === 'fork') {
    try {
      await options.forkDeclineCommenter?.postForkDeclined({
        repo,
        pullNumber: pr.number,
        body: FORK_DECLINE_MESSAGE,
      });
    } catch (error) {
      logger.warn(`failed to post fork-decline comment for ${fullName(repo)}#${pr.number}`, error);
    }
    logger.warn(`declining fork PR ${fullName(repo)}#${pr.number}: ${FORK_DECLINE_MESSAGE}`);
    return { action: 'declined-fork', repo: fullName(repo), number: pr.number };
  }

  const pullRequestId = await upsertPr(sink, repoId, event, pr);

  if (decision.clearReviewActive) {
    await sink.clearOnClose(pullRequestId);
    logger.info(`cleared reviewActive on closed PR ${fullName(repo)}#${pr.number}`);
    return { action: 'cleared', pullRequestId };
  }

  if (decision.setReviewActive) {
    await sink.setReviewActive(pullRequestId, true);
  }

  if (!decision.enqueue || decision.trigger === undefined) {
    return { action: 'noop', reason: 'no trigger' };
  }

  const enqueueInput = {
    pullRequestId,
    repoId,
    headSha: pr.headSha,
    trigger: decision.trigger,
    // Phase 1 runs only the logic Agent (PRD).
    agentKeys: ['logic'],
  };

  if (decision.trigger === 'push') {
    const result = await sink.enqueueSupersedingReviewJob(enqueueInput);
    options.reviewCanceller?.cancelReviewJobs(result.supersededJobIds);
    logger.info(
      `enqueued ReviewJob ${result.reviewJobId} for ${fullName(repo)}#${pr.number} ` +
        `(trigger=${decision.trigger}, superseded=${result.supersededJobIds.length})`,
    );
    return {
      action: 'enqueued',
      reviewJobId: result.reviewJobId,
      trigger: decision.trigger,
      supersededJobIds: result.supersededJobIds,
    };
  }

  const reviewJobId = await sink.enqueueReviewJob(enqueueInput);
  logger.info(
    `enqueued ReviewJob ${reviewJobId} for ${fullName(repo)}#${pr.number} (trigger=${decision.trigger})`,
  );
  return { action: 'enqueued', reviewJobId, trigger: decision.trigger };
}

function upsertPr(
  sink: ReviewSink,
  repoId: string,
  event: Exclude<ParsedEvent, { kind: 'ignored' }>,
  pr: PullRequestFacts,
): Promise<string> {
  const { state } = prStateForEvent(event);
  return sink.upsertPullRequest({
    repoId,
    number: pr.number,
    state,
    draft: pr.draft,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    title: pr.title,
    author: pr.author,
    url: pr.url,
  });
}
