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
  messageClass?: string;
  messageIndicators?: readonly string[];
  providerErrorType?: string;
  providerErrorCode?: string;
  requestParameter?: string;
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
export function codexTurnFailure(info: unknown, message?: unknown): AgentRunFailure {
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
  if (failure.codexErrorInfo === 'other') classifyOtherMessage(failure, message);
  return failure;
}

/** Fixed classes only: messages can contain request bodies, URLs and credentials. */
function classifyOtherMessage(failure: AgentRunFailure, value: unknown): void {
  const message = typeof value === 'string' ? value.slice(0, 4096) : '';
  const indicators: readonly [string, RegExp][] = [
    ['websocket', /websocket/i],
    ['sse', /\bSSE\b/i],
    ['http', /\bHTTP\b/i],
    ['json', /json|ResponseCompleted/i],
    ['timeout', /timed? ?out|timeout/i],
    ['client', /originator|client[ _]?(?:name|id)/i],
    ['model', /\bmodel\b|model_not_found/i],
    ['configuration', /config(?:uration)?/i],
    ['filesystem', /read-only file system|Permission denied|No such file or directory|os error/i],
    ['authentication', /refresh token|authentication|authorization|unauthorized|invalid api key/i],
  ];
  const present = indicators.filter(([, pattern]) => pattern.test(message)).map(([name]) => name);
  if (present.length > 0) failure.messageIndicators = present;
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const details = 'error' in parsed ? parsed.error : parsed;
      failure.messageClass = 'provider-json';
      if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
        const codes = new Set([
          'invalid_request_error',
          'invalid_parameter',
          'unsupported_parameter',
          'unsupported_value',
          'invalid_value',
          'missing_required_parameter',
          'unknown_parameter',
          'invalid_request',
          'model_not_found',
          'invalid_model',
          'unsupported_model',
          'invalid_client',
          'invalid_originator',
          'authentication_error',
          'invalid_api_key',
          'invalid_token',
          'token_expired',
          'unauthorized',
          'permission_denied',
        ]);
        if ('type' in details && typeof details.type === 'string' && codes.has(details.type))
          failure.providerErrorType = details.type;
        if ('code' in details && typeof details.code === 'string' && codes.has(details.code))
          failure.providerErrorCode = details.code;
        const parameters = new Set([
          'model',
          'reasoning.effort',
          'reasoning.summary',
          'parallel_tool_calls',
          'tools',
          'store',
          'truncation',
          'temperature',
          'max_output_tokens',
          'input',
          'originator',
          'clientInfo.name',
          'instructions',
          'metadata',
          'stream',
          'text.verbosity',
          'text.format',
          'tool_choice',
        ]);
        if (
          'param' in details &&
          typeof details.param === 'string' &&
          parameters.has(details.param)
        )
          failure.requestParameter = details.param;
      }
      return;
    }
  } catch {
    // Non-JSON native errors are matched against fixed, bounded patterns below.
  }
  const classes: readonly [string, RegExp][] = [
    ['incomplete-response', /Incomplete response returned/i],
    ['response-json', /failed to parse ResponseCompleted|invalid json|json error/i],
    ['stream-disconnected', /stream disconnected before completion/i],
    ['invalid-request', /invalid[ _]request|unsupported[ _]parameter|invalid[ _]parameter/i],
    ['client', /invalid[ _]client|originator|client[ _]?(?:name|id)/i],
    [
      'model',
      /model_not_found|unsupported model|model.+(?:not supported|not found|does not exist)/i,
    ],
    ['authentication', /refresh token|authentication|authorization|unauthorized|invalid api key/i],
    ['filesystem', /read-only file system|Permission denied|No such file or directory|os error/i],
    ['configuration', /config(?:uration)?/i],
    ['timeout', /timed? ?out|timeout/i],
    ['content-filter', /content_filter/i],
    ['stream', /websocket|\bSSE\b/i],
  ];
  failure.messageClass =
    classes.find(([, pattern]) => pattern.test(message))?.[0] ?? 'unclassified';
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
