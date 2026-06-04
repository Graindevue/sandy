import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ReviewCanceller } from '../worker/cancellation.js';
import {
  type AgentKeysResolver,
  type CommentReplyCapturer,
  type DispatchLogger,
  type DispatchOptions,
  dispatchEvent,
  type ExcludeBranchesResolver,
  type ForkDeclineCommenter,
  type PrCloseSignalCapturer,
} from './dispatch.js';
import { isSupportedEvent, type PullRequestResolver, parseEventForDispatch } from './parse.js';
import { verifySignature } from './signature.js';
import type { ReviewSink } from './sink.js';

/** GitHub caps webhook payloads at 25 MB; reject anything larger to bound memory. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Raised by {@link readRawBody} only when the body exceeds {@link MAX_BODY_BYTES}.
 * A dedicated class lets the handler answer 413 for the size guard while mapping
 * every other read failure (a mid-body `'error'` such as a client disconnect /
 * ECONNRESET) to 500 — 413 is permanent to GitHub (no redelivery), so a transient
 * transport error must not be reported as one.
 */
class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
    this.name = 'PayloadTooLargeError';
  }
}

export interface WebhookServerOptions {
  /** The GitHub App webhook secret used to verify `X-Hub-Signature-256`. */
  webhookSecret: string;
  /** Convex side-effect sink the dispatcher writes through. */
  sink: ReviewSink;
  /** Optional GitHub lookup for issue_comment payloads that carry only an issue number. */
  pullRequestResolver?: PullRequestResolver;
  /** Optional GitHub side-effect used to surface documented v1 fork declines. */
  forkDeclineCommenter?: ForkDeclineCommenter;
  /** Optional close-time poller for Sandy learning signals. */
  closeSignalCapturer?: PrCloseSignalCapturer;
  /** Optional real-time capture for replies under Sandy review comments. */
  replyCapturer?: CommentReplyCapturer;
  /** Optional local cancellation registry for jobs superseded by push deliveries. */
  reviewCanceller?: ReviewCanceller;
  /** Optional resolver for the configured candidate Agent keys of an enqueued Review. */
  resolveAgentKeys?: AgentKeysResolver;
  /** Optional resolver for base branches excluded from automatic review arming. */
  resolveExcludeBranches?: ExcludeBranchesResolver;
  /** Logger; defaults to `console`. */
  logger?: DispatchLogger;
  /** Path the server accepts deliveries on. Defaults to `/`. */
  path?: string;
  /** Max accepted body size in bytes. Defaults to {@link MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
}

/**
 * Read the full request body as a raw Buffer. Rejects with {@link
 * PayloadTooLargeError} once the body passes {@link MAX_BODY_BYTES}, and with the
 * underlying error on a transport failure (`req` `'error'`). On over-size it stops
 * buffering and pauses the stream — but deliberately does NOT `destroy()` the
 * socket, which `req`/`res` share: tearing it down here would reset the connection
 * before the handler's 413 could flush, so the client would see a connection reset
 * rather than the 413. The half-read request is drained by the runtime after the
 * response is sent (Node closes the keep-alive connection in that case).
 */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        req.pause();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Build the request handler for the webhook server. Exposed separately from
 * {@link startWebhookServer} so it can be exercised without binding a port.
 *
 * Contract:
 * - only `POST` to `options.path` is processed; everything else is 404 (or 405).
 * - the RAW body is read first, then `X-Hub-Signature-256` is verified against
 *   it; a missing or invalid signature is rejected with 401 before any parsing.
 * - a verified delivery is parsed and dispatched; unsupported event types and
 *   malformed JSON return 2xx/400 without enqueuing (GitHub treats non-2xx as a
 *   failed delivery and retries, so we only signal a real client error).
 */
export function createWebhookHandler(
  options: WebhookServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const logger = options.logger ?? console;
  const path = options.path ?? '/';
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  return async (req, res) => {
    if (req.url !== path) {
      send(res, 404, 'not found');
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, 'method not allowed');
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        send(res, 413, 'payload too large');
        return;
      }
      // A transport failure (client disconnect / ECONNRESET mid-body) is transient;
      // 500 lets GitHub redeliver. 413 would be treated as permanent and drop it.
      logger.warn('failed to read webhook body', error);
      if (!res.headersSent) {
        send(res, 500, 'failed to read body');
      }
      return;
    }

    const signature = headerValue(req.headers['x-hub-signature-256']);
    if (!verifySignature(options.webhookSecret, rawBody, signature)) {
      logger.warn('rejected webhook: missing or invalid signature');
      send(res, 401, 'invalid signature');
      return;
    }

    const eventName = headerValue(req.headers['x-github-event']);
    if (!isSupportedEvent(eventName)) {
      // Verified but not an event we act on (e.g. `ping`). Acknowledge so GitHub
      // doesn't retry.
      send(res, 202, 'ignored event');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      send(res, 400, 'invalid JSON');
      return;
    }

    try {
      const parsed = await parseEventForDispatch(eventName, payload, options.pullRequestResolver);
      const outcome = await dispatchEvent(parsed, options.sink, logger, dispatchOptions(options));
      send(res, 200, outcome.action);
    } catch (error) {
      // A side-effect failure (e.g. Convex unreachable) is a server error; 500
      // lets GitHub retry the delivery.
      logger.warn('webhook dispatch failed', error);
      send(res, 500, 'dispatch failed');
    }
  };
}

function dispatchOptions(options: WebhookServerOptions): DispatchOptions | undefined {
  if (
    options.forkDeclineCommenter === undefined &&
    options.closeSignalCapturer === undefined &&
    options.replyCapturer === undefined &&
    options.reviewCanceller === undefined &&
    options.resolveAgentKeys === undefined &&
    options.resolveExcludeBranches === undefined
  ) {
    return undefined;
  }
  const dispatch: DispatchOptions = {};
  if (options.forkDeclineCommenter !== undefined) {
    dispatch.forkDeclineCommenter = options.forkDeclineCommenter;
  }
  if (options.closeSignalCapturer !== undefined) {
    dispatch.closeSignalCapturer = options.closeSignalCapturer;
  }
  if (options.replyCapturer !== undefined) {
    dispatch.replyCapturer = options.replyCapturer;
  }
  if (options.reviewCanceller !== undefined) {
    dispatch.reviewCanceller = options.reviewCanceller;
  }
  if (options.resolveAgentKeys !== undefined) {
    dispatch.resolveAgentKeys = options.resolveAgentKeys;
  }
  if (options.resolveExcludeBranches !== undefined) {
    dispatch.resolveExcludeBranches = options.resolveExcludeBranches;
  }
  return dispatch;
}

/** Create and start the webhook HTTP server, resolving once it is listening. */
export function startWebhookServer(port: number, options: WebhookServerOptions): Promise<Server> {
  const handler = createWebhookHandler(options);
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      (options.logger ?? console).warn('unhandled webhook error', error);
      if (!res.headersSent) {
        send(res, 500, 'internal error');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
