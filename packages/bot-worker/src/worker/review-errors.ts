export class ReviewSupersededError extends Error {
  constructor(readonly jobId: string) {
    super(`ReviewJob ${jobId} was superseded by a newer review`);
    this.name = 'ReviewSupersededError';
  }
}

export function isReviewSupersededError(error: unknown): error is ReviewSupersededError {
  return error instanceof ReviewSupersededError;
}
