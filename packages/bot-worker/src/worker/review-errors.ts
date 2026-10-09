import type { AgentRunUsage } from '@sandy/shared-types';

/** Adapter failures can still carry authoritative usage from their own thread. */
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly usage?: AgentRunUsage,
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export class ReviewSupersededError extends Error {
  constructor(readonly jobId: string) {
    super(`ReviewJob ${jobId} was superseded by a newer review`);
    this.name = 'ReviewSupersededError';
  }
}

export function isReviewSupersededError(error: unknown): error is ReviewSupersededError {
  return error instanceof ReviewSupersededError;
}
