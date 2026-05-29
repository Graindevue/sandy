import { pathToFileURL } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { startWebhookServer } from './webhook/server.js';
import { ConvexSink } from './webhook/sink.js';

/** Resolved worker configuration, read once from the environment at startup. */
export interface WorkerConfig {
  webhookSecret: string;
  convexUrl: string;
  port: number;
}

const DEFAULT_PORT = 3007;

/**
 * Read and validate the worker's configuration from `env`. Throws with a clear
 * message if a required variable is missing or `PORT` is not a valid port, so a
 * misconfigured deploy fails loudly at boot rather than silently mis-routing.
 */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const webhookSecret = env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('WEBHOOK_SECRET is required');
  }
  const convexUrl = env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error('CONVEX_URL is required');
  }

  let port = DEFAULT_PORT;
  if (env.PORT !== undefined && env.PORT !== '') {
    port = Number.parseInt(env.PORT, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`PORT must be a valid port number, got ${JSON.stringify(env.PORT)}`);
    }
  }

  return { webhookSecret, convexUrl, port };
}

/**
 * Worker entry point: load config, build the Convex client + sink, and start the
 * webhook server. The job claimant and Sandcastle Agent run are issue #6 and are
 * intentionally not started here — this process is only the webhook front door.
 */
export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new ConvexHttpClient(config.convexUrl);
  const sink = new ConvexSink(client);

  await startWebhookServer(config.port, { webhookSecret: config.webhookSecret, sink });
  console.info(`Sandy webhook server listening on :${config.port}`);
}

/**
 * Whether this module is the process entry point (`node dist/main.js`) rather
 * than an import (e.g. from tests). `import.meta.url` is a percent-encoded
 * `file://` URL, so the script path must be encoded the same way via
 * {@link pathToFileURL} — a raw `` `file://${argv1}` `` concat fails to match on
 * any install path containing a space, `#`, `?`, `%`, or non-ASCII character,
 * which would silently skip {@link main} and boot a worker that binds no port.
 */
export function isMainModule(importMetaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  return importMetaUrl === pathToFileURL(argv1).href;
}

// Run only when executed directly, not when imported by tests.
if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('failed to start bot-worker', error);
    process.exit(1);
  });
}
