import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { setTimeout as defaultSleep } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { normalizeOllamaHost, OLLAMA_EMBEDDING_MODEL } from './embed.js';

const OLLAMA_BINARY = 'ollama';
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

type FetchLike = typeof fetch;

interface OllamaTagsResponse {
  models?: unknown;
}

interface OllamaModel {
  name?: string;
  model?: string;
}

interface TagsResult {
  ok: boolean;
  models?: OllamaModel[];
  error?: string;
}

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

  let tags = await readTags(fetcher, host);
  if (!tags.ok) {
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

    tags = await waitForTags({
      fetcher,
      host,
      retryDelaysMs,
      sleep,
    });
    if (!tags.ok) {
      return disabled(
        host,
        model,
        `Ollama did not become reachable at ${host}: ${tags.error ?? 'unknown error'}`,
        logger,
      );
    }
  }

  if (!hasModel(tags.models ?? [], model)) {
    logger.info(`Ollama model ${model} is missing; pulling it now.`);
    const pulled = await pullModel({ fetcher, host, model, logger });
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

async function waitForTags(input: {
  fetcher: FetchLike;
  host: string;
  retryDelaysMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
}): Promise<TagsResult> {
  let lastResult: TagsResult = { ok: false, error: 'Ollama did not become reachable' };
  for (const delayMs of input.retryDelaysMs) {
    await input.sleep(delayMs);
    lastResult = await readTags(input.fetcher, input.host);
    if (lastResult.ok) {
      return lastResult;
    }
  }
  return lastResult;
}

async function readTags(fetcher: FetchLike, host: string): Promise<TagsResult> {
  try {
    const response = await fetcher(`${host}/api/tags`);
    if (!response.ok) {
      return {
        ok: false,
        error: `Ollama tags request failed with ${response.status}: ${await response.text()}`,
      };
    }
    const body = (await response.json()) as OllamaTagsResponse;
    return { ok: true, models: parseModels(body.models) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function pullModel(input: {
  fetcher: FetchLike;
  host: string;
  model: string;
  logger: OllamaProvisionerLogger;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await input.fetcher(`${input.host}/api/pull`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: input.model, stream: true }),
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `Ollama model ${input.model} pull failed with ${response.status}: ${await response.text()}`,
      };
    }
    await logPullProgress(response, input.model, input.logger);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Ollama model ${input.model} pull failed: ${errorMessage(error)}`,
    };
  }
}

async function logPullProgress(
  response: Response,
  model: string,
  logger: OllamaProvisionerLogger,
): Promise<void> {
  if (response.body === null) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastStatus: string | null = null;

  for (;;) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    buffer += decoder.decode(read.value, { stream: true });
    const flushed = logCompleteProgressLines(buffer, model, logger, lastStatus);
    buffer = flushed.remainder;
    lastStatus = flushed.lastStatus;
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    logProgressLine(buffer, model, logger, lastStatus);
  }
}

function logCompleteProgressLines(
  buffer: string,
  model: string,
  logger: OllamaProvisionerLogger,
  lastStatus: string | null,
): { remainder: string; lastStatus: string | null } {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  let status = lastStatus;
  for (const line of lines) {
    status = logProgressLine(line, model, logger, status);
  }
  return { remainder, lastStatus: status };
}

function logProgressLine(
  raw: string,
  model: string,
  logger: OllamaProvisionerLogger,
  lastStatus: string | null,
): string | null {
  const line = raw.trim();
  if (line.length === 0) {
    return lastStatus;
  }

  const status = pullStatus(line);
  if (status === null || status === lastStatus) {
    return lastStatus;
  }

  logger.info(`Ollama pull ${model}: ${status}`);
  return status;
}

function pullStatus(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { status?: unknown };
    return typeof parsed.status === 'string' ? parsed.status : null;
  } catch {
    return line;
  }
}

function parseModels(value: unknown): OllamaModel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => parseModel(item)).filter((item): item is OllamaModel => item !== null);
}

function parseModel(value: unknown): OllamaModel | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const model: OllamaModel = {};
  if (typeof record.name === 'string') {
    model.name = record.name;
  }
  if (typeof record.model === 'string') {
    model.model = record.model;
  }
  return model;
}

function hasModel(models: readonly OllamaModel[], model: string): boolean {
  return models.some((entry) =>
    [entry.name, entry.model].some((name) => typeof name === 'string' && matchesModel(name, model)),
  );
}

function matchesModel(name: string, model: string): boolean {
  return name === model || name === `${model}:latest` || name.startsWith(`${model}:`);
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
