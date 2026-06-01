import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { setTimeout as defaultSleep } from 'node:timers/promises';
import { normalizeOllamaHost, OLLAMA_EMBEDDING_MODEL } from './embed.js';
import {
  type FetchLike,
  hasOllamaModel,
  type OllamaModelNamesResult,
  pullOllamaModel,
  readOllamaModelNames,
} from './ollama-api.js';

const OLLAMA_BINARY = 'ollama';
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

export type OllamaProvisioningResult =
  | {
      ready: true;
      host: string;
      model: string;
    }
  | {
      ready: false;
      host: string;
      model: string;
      reason: string;
    };

export interface OllamaProvisionerLogger {
  info(message: string): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface OllamaDaemonProcess {
  on(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface OllamaProvisionerOptions {
  host?: string;
  model?: string;
  fetch?: FetchLike;
  logger?: OllamaProvisionerLogger;
  binary?: string;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  runOllamaVersion?: (binary: string) => Promise<void>;
  startOllama?: (input: { binary: string; host: string }) => OllamaDaemonProcess;
}

const defaultLogger: OllamaProvisionerLogger = console;

export async function provisionOllamaEmbeddingBackend(
  options: OllamaProvisionerOptions = {},
): Promise<OllamaProvisioningResult> {
  const host = normalizeOllamaHost(options.host);
  const model = options.model ?? OLLAMA_EMBEDDING_MODEL;
  const fetcher = options.fetch ?? fetch;
  const logger = options.logger ?? defaultLogger;
  const binary = options.binary ?? OLLAMA_BINARY;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const runOllamaVersion = options.runOllamaVersion ?? defaultRunOllamaVersion;
  const startOllama = options.startOllama ?? defaultStartOllama;

  let models = await readOllamaModelNames(fetcher, host);
  if (!models.ok) {
    const binaryAvailable = await hasOllamaBinary(binary, runOllamaVersion);
    if (!binaryAvailable) {
      const reason = '`ollama` binary not found on PATH';
      logger.warn(
        `Ollama is not reachable at ${host} and the \`ollama\` binary is not on PATH. ` +
          'Install Ollama or set OLLAMA_HOST; learning-loop archetype clustering is disabled for this worker session.',
      );
      return { ready: false, host, model, reason };
    }

    logger.info(`Ollama is not reachable at ${host}; starting \`${binary} serve\`.`);
    const started = startOllamaDaemon({ binary, host, logger, startOllama });
    if (!started.ok) {
      return disabled(host, model, started.reason, logger);
    }

    models = await waitForModelNames({
      fetcher,
      host,
      retryDelaysMs,
      sleep,
    });
    if (!models.ok) {
      return disabled(
        host,
        model,
        `Ollama did not become reachable at ${host}: ${models.error}`,
        logger,
      );
    }
  }

  if (!hasOllamaModel(models.modelNames, model)) {
    logger.info(`Ollama model ${model} is missing; pulling it now.`);
    const pulled = await pullOllamaModel({ fetcher, host, model, logger });
    if (!pulled.ok) {
      return disabled(host, model, pulled.reason, logger);
    }
  }

  return { ready: true, host, model };
}

function disabled(
  host: string,
  model: string,
  reason: string,
  logger: OllamaProvisionerLogger,
): OllamaProvisioningResult {
  logger.warn(`${reason}; learning-loop archetype clustering is disabled for this worker session.`);
  return { ready: false, host, model, reason };
}

async function waitForModelNames(input: {
  fetcher: FetchLike;
  host: string;
  retryDelaysMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
}): Promise<OllamaModelNamesResult> {
  let lastResult: OllamaModelNamesResult = {
    ok: false,
    error: 'Ollama did not become reachable',
  };
  for (const delayMs of input.retryDelaysMs) {
    await input.sleep(delayMs);
    lastResult = await readOllamaModelNames(input.fetcher, input.host);
    if (lastResult.ok) {
      return lastResult;
    }
  }
  return lastResult;
}

async function hasOllamaBinary(
  binary: string,
  runOllamaVersion: (binary: string) => Promise<void>,
): Promise<boolean> {
  try {
    await runOllamaVersion(binary);
    return true;
  } catch (error) {
    return !isNotFound(error);
  }
}

function startOllamaDaemon(input: {
  binary: string;
  host: string;
  logger: OllamaProvisionerLogger;
  startOllama: (input: { binary: string; host: string }) => OllamaDaemonProcess;
}): { ok: true } | { ok: false; reason: string } {
  try {
    const daemon = input.startOllama({ binary: input.binary, host: input.host });
    daemon.on('error', (error) => {
      input.logger.warn(`Ollama daemon reported an error: ${errorMessage(error)}`);
    });
    daemon.unref();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Failed to start \`${input.binary} serve\`: ${errorMessage(error)}`,
    };
  }
}

function defaultRunOllamaVersion(binary: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function defaultStartOllama(input: { binary: string; host: string }): ChildProcess {
  return spawn(input.binary, ['serve'], {
    detached: true,
    env: { ...process.env, OLLAMA_HOST: input.host },
    stdio: 'ignore',
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
