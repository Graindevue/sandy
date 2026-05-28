import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type DispatchLogger, dispatchEvent } from './dispatch.js';
import { isSupportedEvent, parseEvent } from './parse.js';
import { verifySignature } from './signature.js';
import type { ReviewSink } from './sink.js';

/** GitHub caps webhook payloads at 25 MB; reject anything larger to bound memory. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export interface WebhookServerOptions {
  /** The GitHub App webhook secret used to verify `X-Hub-Signature-256`. */
  webhookSecret: string;
  /** Convex side-effect sink the dispatcher writes through. */
  sink: ReviewSink;
  /** Logger; defaults to `console`. */
  logger?: DispatchLogger;
  /** Path the server accepts deliveries on. Defaults to `/webhook`. */
  path?: string;
}

/** Read the full request body as a raw Buffer, rejecting over-large payloads. */
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
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
  const path = options.path ?? '/webhook';

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
      rawBody = await readRawBody(req);
    } catch {
      send(res, 413, 'payload too large');
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
      const parsed = parseEvent(eventName, payload);
      const outcome = await dispatchEvent(parsed, options.sink, logger);
      send(res, 200, outcome.action);
    } catch (error) {
      // A side-effect failure (e.g. Convex unreachable) is a server error; 500
      // lets GitHub retry the delivery.
      logger.warn('webhook dispatch failed', error);
      send(res, 500, 'dispatch failed');
    }
  };
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
