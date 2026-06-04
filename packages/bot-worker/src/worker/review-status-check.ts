import type { PostedSummaryComment } from './poster.js';

export type ReviewStatusCheckConclusion = 'success' | 'neutral' | 'failure';

export interface CreateReviewStatusCheckInput {
  owner: string;
  repo: string;
  headSha: string;
  pullRequestUrl: string;
  startedAt: number;
}

export interface CompleteReviewStatusCheckInput {
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: ReviewStatusCheckConclusion;
  detailsUrl: string;
  summaryCommentUrl?: string;
  verdict: string;
  completedAt: number;
}

export interface ReviewStatusCheckReporter {
  createInProgress(input: CreateReviewStatusCheckInput): Promise<{ id: number }>;
  complete(input: CompleteReviewStatusCheckInput): Promise<void>;
}

export interface ReviewStatusCheckStore {
  setReviewCheckRunId(jobId: string, checkRunId: number): Promise<void>;
}

export interface ReviewStatusCheckLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface ReviewStatusCheckContext {
  job: {
    id: string;
    headSha: string;
    checkRunId?: number;
  };
  repo: {
    owner: string;
    name: string;
  };
  pullRequest: {
    url: string;
  };
}

export interface ReviewStatusCheckOutcome {
  conclusion: ReviewStatusCheckConclusion;
  verdict: string;
}

export const REVIEW_STATUS_CHECK_OUTCOMES = {
  scopeDeclined: {
    conclusion: 'neutral',
    verdict: 'Sandy skipped this review',
  },
  reviewFailed: {
    conclusion: 'failure',
    verdict: 'Sandy failed to run',
  },
} as const satisfies Record<string, ReviewStatusCheckOutcome>;

export interface StartReviewStatusCheckInput {
  context: ReviewStatusCheckContext;
  reporter?: ReviewStatusCheckReporter | null;
  store: ReviewStatusCheckStore;
  now: () => number;
  logger: ReviewStatusCheckLogger;
}

export interface CompleteReviewStatusCheckRunInput {
  outcome: ReviewStatusCheckOutcome;
  summaryComment?: PostedSummaryComment;
}

export interface ReviewStatusCheckRun {
  complete(input: CompleteReviewStatusCheckRunInput): Promise<void>;
}

class StartedReviewStatusCheckRun implements ReviewStatusCheckRun {
  readonly #context: ReviewStatusCheckContext;
  readonly #reporter: ReviewStatusCheckReporter | null;
  readonly #checkRunId: number | null;
  readonly #now: () => number;
  readonly #logger: ReviewStatusCheckLogger;

  constructor(input: {
    context: ReviewStatusCheckContext;
    reporter: ReviewStatusCheckReporter | null;
    checkRunId: number | null;
    now: () => number;
    logger: ReviewStatusCheckLogger;
  }) {
    this.#context = input.context;
    this.#reporter = input.reporter;
    this.#checkRunId = input.checkRunId;
    this.#now = input.now;
    this.#logger = input.logger;
  }

  async complete(input: CompleteReviewStatusCheckRunInput): Promise<void> {
    if (this.#reporter === null || this.#checkRunId === null) {
      return;
    }

    const request: CompleteReviewStatusCheckInput = {
      owner: this.#context.repo.owner,
      repo: this.#context.repo.name,
      checkRunId: this.#checkRunId,
      conclusion: input.outcome.conclusion,
      detailsUrl: input.summaryComment?.url ?? this.#context.pullRequest.url,
      verdict: input.outcome.verdict,
      completedAt: this.#now(),
    };
    if (input.summaryComment !== undefined) {
      request.summaryCommentUrl = input.summaryComment.url;
    }

    try {
      await this.#reporter.complete(request);
    } catch (error) {
      this.#logger.warn(
        `failed to update Sandy Check Run ${this.#checkRunId} for ReviewJob ${this.#context.job.id}`,
        error,
      );
    }
  }
}

export async function startReviewStatusCheck(
  input: StartReviewStatusCheckInput,
): Promise<ReviewStatusCheckRun> {
  const reporter = input.reporter ?? null;
  if (reporter === null || input.context.job.checkRunId !== undefined) {
    return new StartedReviewStatusCheckRun({
      context: input.context,
      reporter,
      checkRunId: input.context.job.checkRunId ?? null,
      now: input.now,
      logger: input.logger,
    });
  }

  let checkRunId: number;
  try {
    const check = await reporter.createInProgress({
      owner: input.context.repo.owner,
      repo: input.context.repo.name,
      headSha: input.context.job.headSha,
      pullRequestUrl: input.context.pullRequest.url,
      startedAt: input.now(),
    });
    checkRunId = check.id;
  } catch (error) {
    input.logger.warn(
      `failed to create Sandy Check Run for ReviewJob ${input.context.job.id}`,
      error,
    );
    return new StartedReviewStatusCheckRun({
      context: input.context,
      reporter,
      checkRunId: null,
      now: input.now,
      logger: input.logger,
    });
  }

  try {
    await input.store.setReviewCheckRunId(input.context.job.id, checkRunId);
  } catch (error) {
    input.logger.warn(
      `failed to persist Sandy Check Run ${checkRunId} for ReviewJob ${input.context.job.id}`,
      error,
    );
  }

  return new StartedReviewStatusCheckRun({
    context: input.context,
    reporter,
    checkRunId,
    now: input.now,
    logger: input.logger,
  });
}

export function completedReviewStatusCheckOutcome(input: {
  selectedAgentCount: number;
  failedAgentCount: number;
  postedFindingCount: number;
}): ReviewStatusCheckOutcome {
  const successfulAgentCount = input.selectedAgentCount - input.failedAgentCount;
  if (input.selectedAgentCount > 0 && successfulAgentCount === 0) {
    return {
      conclusion: 'failure',
      verdict: 'Sandy failed to produce review results',
    };
  }

  if (input.failedAgentCount > 0) {
    return {
      conclusion: 'neutral',
      verdict: 'Sandy completed with partial agent failures',
    };
  }

  if (input.postedFindingCount > 0) {
    return {
      conclusion: 'neutral',
      verdict: `Sandy posted ${formatCountWithNoun(input.postedFindingCount, 'finding')}`,
    };
  }

  if (input.selectedAgentCount === 0) {
    return {
      conclusion: 'neutral',
      verdict: 'Sandy completed without running agents',
    };
  }

  return {
    conclusion: 'success',
    verdict: 'Sandy ran cleanly',
  };
}

function formatCountWithNoun(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
