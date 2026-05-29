export class ReviewSupersededError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`ReviewJob ${jobId} was superseded by a newer push`);
    this.name = 'ReviewSupersededError';
    this.jobId = jobId;
  }
}

export function isReviewSupersededError(error: unknown): error is ReviewSupersededError {
  return error instanceof ReviewSupersededError;
}

export interface RegisteredReviewCancellation {
  signal: AbortSignal;
  dispose(): void;
}

export interface ReviewCancellationRegistry {
  register(jobId: string): RegisteredReviewCancellation;
}

export interface ReviewCanceller {
  cancelReviewJobs(jobIds: readonly string[]): void;
}

export class ReviewCancellationCoordinator implements ReviewCancellationRegistry, ReviewCanceller {
  readonly #controllers = new Map<string, AbortController>();
  readonly #superseded = new Set<string>();

  register(jobId: string): RegisteredReviewCancellation {
    const controller = new AbortController();
    this.#controllers.set(jobId, controller);

    if (this.#superseded.has(jobId)) {
      controller.abort(new ReviewSupersededError(jobId));
    }

    return {
      signal: controller.signal,
      dispose: () => {
        this.#controllers.delete(jobId);
        this.#superseded.delete(jobId);
      },
    };
  }

  cancelReviewJobs(jobIds: readonly string[]): void {
    for (const jobId of jobIds) {
      this.#superseded.add(jobId);
      const controller = this.#controllers.get(jobId);
      if (controller !== undefined && !controller.signal.aborted) {
        controller.abort(new ReviewSupersededError(jobId));
      }
    }
  }
}
