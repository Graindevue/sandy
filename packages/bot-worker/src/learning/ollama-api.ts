import { TextDecoder } from 'node:util';

export type FetchLike = typeof fetch;

export interface OllamaApiLogger {
  info(message: string): void;
}

export type OllamaModelNamesResult =
  | {
      ok: true;
      modelNames: string[];
    }
  | {
      ok: false;
      error: string;
    };

export type OllamaModelPullResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

interface OllamaTagsResponse {
  models?: unknown;
}

export async function readOllamaModelNames(
  fetcher: FetchLike,
  host: string,
): Promise<OllamaModelNamesResult> {
  try {
    const response = await fetcher(`${host}/api/tags`);
    if (!response.ok) {
      return {
        ok: false,
        error: `Ollama tags request failed with ${response.status}: ${await response.text()}`,
      };
    }
    const body = (await response.json()) as OllamaTagsResponse;
    return { ok: true, modelNames: parseModelNames(body.models) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function pullOllamaModel(input: {
  fetcher: FetchLike;
  host: string;
  model: string;
  logger: OllamaApiLogger;
}): Promise<OllamaModelPullResult> {
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

export function hasOllamaModel(modelNames: readonly string[], model: string): boolean {
  return modelNames.some((name) => matchesModel(name, model));
}

async function logPullProgress(
  response: Response,
  model: string,
  logger: OllamaApiLogger,
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
  logger: OllamaApiLogger,
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
  logger: OllamaApiLogger,
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

function parseModelNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const modelNames: string[] = [];
  for (const item of value) {
    modelNames.push(...modelNamesFromTag(item));
  }
  return modelNames;
}

function modelNamesFromTag(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const modelNames: string[] = [];
  if ('name' in value && typeof value.name === 'string') {
    modelNames.push(value.name);
  }
  if ('model' in value && typeof value.model === 'string') {
    modelNames.push(value.model);
  }
  return modelNames;
}

function matchesModel(name: string, model: string): boolean {
  return name === model || name === `${model}:latest` || name.startsWith(`${model}:`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
