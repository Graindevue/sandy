import type { AgentRunUsage } from '@sandy/shared-types';

export interface AgentRunFailure {
  stage: 'runtime' | 'authentication' | 'thread-start' | 'turn-start' | 'turn';
  code:
    | 'rpc-error'
    | 'rpc-timeout'
    | 'turn-failed'
    | 'protocol-error'
    | 'runtime-exited'
    | 'unknown';
  rpcCode?: number;
  codexErrorInfo?: string;
  httpStatusCode?: number;
}

/** Adapter failures can still carry authoritative usage from their own thread. */
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly usage?: AgentRunUsage,
    readonly failure?: AgentRunFailure,
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export function agentRunFailure(error: unknown): AgentRunFailure {
  return error instanceof AgentRunError && error.failure !== undefined
    ? error.failure
    : { stage: 'runtime', code: 'unknown' };
}

/** Only protocol enums and numeric status codes may enter benchmark artifacts. */
export function codexTurnFailure(info: unknown): AgentRunFailure {
  const failure: AgentRunFailure = { stage: 'turn', code: 'turn-failed' };
  const names = new Set([
    'contextWindowExceeded',
    'sessionBudgetExceeded',
    'usageLimitExceeded',
    'rateLimitExceeded',
    'flexUnavailable',
    'serverOverloaded',
    'cyberPolicy',
    'misalignmentPolicyViolation',
    'tooManyDenials',
    'internalServerError',
    'unauthorized',
    'badRequest',
    'threadRollbackFailed',
    'sandboxError',
    'other',
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
    'activeTurnNotSteerable',
  ]);
  if (typeof info === 'string' && names.has(info)) failure.codexErrorInfo = info;
  else if (typeof info === 'object' && info !== null && !Array.isArray(info)) {
    const entries = Object.entries(info);
    if (entries.length === 1) {
      const [name, details] = entries[0] ?? [];
      if (typeof name === 'string' && names.has(name)) {
        failure.codexErrorInfo = name;
        const status =
          typeof details === 'object' && details !== null && 'httpStatusCode' in details
            ? details.httpStatusCode
            : undefined;
        if (
          typeof status === 'number' &&
          Number.isInteger(status) &&
          status >= 100 &&
          status <= 599
        )
          failure.httpStatusCode = status;
      }
    }
  }
  return failure;
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
