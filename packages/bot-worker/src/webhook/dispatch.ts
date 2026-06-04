import type { ReviewTrigger } from '@sandy/shared-types';
import type { ReviewCanceller } from '../worker/cancellation.js';
import type {
  CommentEvent,
  ParsedEvent,
  PullRequestBackedEvent,
  PullRequestFacts,
  RepoRef,
} from './events.js';
import { prStateForEvent } from './parse.js';
import type { EnqueueInput, ReviewSink } from './sink.js';
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

export interface PrCloseSignalCapturer {
  capturePrCloseSignals(input: {
    repo: RepoRef;
    pullNumber: number;
    pullRequestId: string;
    state: PullRequestFacts['state'];
  }): Promise<{ recorded: number } | undefined>;
}

export interface CommentReplyCapturer {
  captureCommentReply(input: {
    repo: RepoRef;
    pullNumber: number;
    pullRequestId: string;
    comment: {
      id: number;
      body: string;
      inReplyToId?: number;
    };
  }): Promise<{ recorded: number } | undefined>;
}

/**
 * Resolves which Agent keys a Review should enqueue for a Repo, from instance
 * config (`bot.yaml`'s per-Product `agents` list). Injected so {@link dispatchEvent}
 * stays decoupled from the ConfigLoader. Returns the Product's configured candidate
 * Agents — the worker refines them at worktree time (framework auto-detect +
 * `.bot/agents.yaml` overrides) via `selectAgentsForReview`.
 */
export type AgentKeysResolver = (repo: RepoRef) => string[];

export interface DispatchOptions {
  forkDeclineCommenter?: ForkDeclineCommenter;
  closeSignalCapturer?: PrCloseSignalCapturer;
  replyCapturer?: CommentReplyCapturer;
  reviewCanceller?: ReviewCanceller;
  resolveAgentKeys?: AgentKeysResolver;
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
 * Superseding reviews use a single Convex mutation that supersedes active stale
 * jobs and enqueues (or reuses) the new-head job atomically; any local running
 * jobs returned by that mutation are then aborted through the optional
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

  if (event.kind === 'comment') {
    await captureCommentReply(event, pullRequestId, logger, options.replyCapturer);
  }

  if (decision.clearReviewActive) {
    const captureResult = await options.closeSignalCapturer?.capturePrCloseSignals({
      repo,
      pullNumber: pr.number,
      pullRequestId,
      state: pr.state,
    });
    if (captureResult !== undefined) {
      logger.info(
        `captured ${captureResult.recorded} close-time signal(s) on closed PR ${fullName(repo)}#${pr.number}`,
      );
    }
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

  const trigger = decision.trigger;
  const enqueueInput = {
    pullRequestId,
    repoId,
    headSha: pr.headSha,
    trigger,
    // The Product's configured candidate Agents, from bot.yaml. An empty result
    // (Repo not in config) is preserved as-is — the worker would resolve no
    // Agents for it either. The `['logic']` fallback only applies when no resolver
    // is injected (e.g. unit tests that construct DispatchOptions directly).
    agentKeys: options.resolveAgentKeys?.(repo) ?? ['logic'],
  };

  const enqueueResult = await enqueueReviewForTrigger(sink, enqueueInput, options.reviewCanceller);
  logger.info(enqueueLogMessage(repo, pr, trigger, enqueueResult));
  if (enqueueResult.supersededJobIds !== undefined) {
    return {
      action: 'enqueued',
      reviewJobId: enqueueResult.reviewJobId,
      trigger,
      supersededJobIds: enqueueResult.supersededJobIds,
    };
  }

  return { action: 'enqueued', reviewJobId: enqueueResult.reviewJobId, trigger };
}

async function captureCommentReply(
  event: CommentEvent,
  pullRequestId: string,
  logger: DispatchLogger,
  replyCapturer: CommentReplyCapturer | undefined,
): Promise<void> {
  if (
    replyCapturer === undefined ||
    event.commentKind !== 'pull_request_review_comment' ||
    event.githubCommentId === undefined
  ) {
    return;
  }

  const comment =
    event.inReplyToId === undefined
      ? { id: event.githubCommentId, body: event.body }
      : { id: event.githubCommentId, body: event.body, inReplyToId: event.inReplyToId };
  const captureResult = await replyCapturer.captureCommentReply({
    repo: event.repo,
    pullNumber: event.pr.number,
    pullRequestId,
    comment,
  });
  if (captureResult !== undefined && captureResult.recorded > 0) {
    logger.info(
      `captured ${captureResult.recorded} reply reaction(s) on ${fullName(event.repo)}#${event.pr.number}`,
    );
  }
}

async function enqueueReviewForTrigger(
  sink: ReviewSink,
  input: EnqueueInput,
  reviewCanceller: ReviewCanceller | undefined,
): Promise<{ reviewJobId: string; supersededJobIds?: string[] }> {
  if (!usesSupersedingEnqueue(input.trigger)) {
    return { reviewJobId: await sink.enqueueReviewJob(input) };
  }

  const result = await sink.enqueueSupersedingReviewJob(input);
  reviewCanceller?.cancelReviewJobs(result.supersededJobIds);
  return {
    reviewJobId: result.reviewJobId,
    supersededJobIds: result.supersededJobIds,
  };
}

function usesSupersedingEnqueue(trigger: ReviewTrigger): boolean {
  return trigger === 'push' || trigger === 'rerun';
}

function enqueueLogMessage(
  repo: RepoRef,
  pr: PullRequestFacts,
  trigger: ReviewTrigger,
  result: { reviewJobId: string; supersededJobIds?: string[] },
): string {
  const prefix = `enqueued ReviewJob ${result.reviewJobId} for ${fullName(repo)}#${pr.number}`;
  if (result.supersededJobIds === undefined) {
    return `${prefix} (trigger=${trigger})`;
  }
  return `${prefix} (trigger=${trigger}, superseded=${result.supersededJobIds.length})`;
}

function upsertPr(
  sink: ReviewSink,
  repoId: string,
  event: PullRequestBackedEvent,
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
