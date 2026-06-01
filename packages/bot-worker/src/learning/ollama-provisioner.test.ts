import { describe, expect, it } from 'vitest';
import { provisionOllamaEmbeddingBackend } from './ollama-provisioner.js';

describe('provisionOllamaEmbeddingBackend', () => {
  it('uses a reachable Ollama backend when nomic-embed-text is already present', async () => {
    const logger = new FakeLogger();
    const calls: string[] = [];
    const result = await provisionOllamaEmbeddingBackend({
      fetch: async (input) => {
        calls.push(String(input));
        return tagsResponse(['nomic-embed-text:latest']);
      },
      logger,
      runOllamaVersion: async () => {
        throw new Error('should not check the binary when the daemon is reachable');
      },
      startOllama: () => {
        throw new Error('should not start Ollama when the daemon is reachable');
      },
    });

    expect(result).toEqual({
      ready: true,
      host: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
    });
    expect(calls).toEqual(['http://127.0.0.1:11434/api/tags']);
    expect(logger.warnings).toEqual([]);
  });

  it('pulls nomic-embed-text when Ollama is reachable but the model is missing', async () => {
    const logger = new FakeLogger();
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await provisionOllamaEmbeddingBackend({
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        if (String(input).endsWith('/api/pull')) {
          return new Response(
            [
              JSON.stringify({ status: 'pulling manifest' }),
              JSON.stringify({ status: 'success' }),
            ].join('\n'),
            { status: 200 },
          );
        }
        return tagsResponse(['llama3.2:latest']);
      },
      logger,
    });

    expect(result.ready).toBe(true);
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:11434/api/tags', body: undefined },
      {
        url: 'http://127.0.0.1:11434/api/pull',
        body: { name: 'nomic-embed-text', stream: true },
      },
    ]);
    expect(logger.infos).toContain('Ollama model nomic-embed-text is missing; pulling it now.');
    expect(logger.infos).toContain('Ollama pull nomic-embed-text: pulling manifest');
    expect(logger.infos).toContain('Ollama pull nomic-embed-text: success');
  });

  it('starts Ollama and retries when the daemon is down but the binary is present', async () => {
    const logger = new FakeLogger();
    const sleeps: number[] = [];
    const starts: string[] = [];
    let tagsAttempts = 0;

    const result = await provisionOllamaEmbeddingBackend({
      fetch: async (input) => {
        if (!String(input).endsWith('/api/tags')) {
          throw new Error(`unexpected fetch ${String(input)}`);
        }
        tagsAttempts += 1;
        if (tagsAttempts === 1) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
        }
        return tagsResponse(['nomic-embed-text:latest']);
      },
      logger,
      retryDelaysMs: [5, 10],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      runOllamaVersion: async (binary) => {
        expect(binary).toBe('ollama');
      },
      startOllama: ({ binary }) => {
        starts.push(binary);
        return fakeDaemon();
      },
    });

    expect(result.ready).toBe(true);
    expect(tagsAttempts).toBe(2);
    expect(starts).toEqual(['ollama']);
    expect(sleeps).toEqual([5]);
    expect(logger.infos).toContain(
      'Ollama is not reachable at http://127.0.0.1:11434; starting `ollama serve`.',
    );
  });

  it('disables learning once when Ollama is unreachable and the binary is absent', async () => {
    const logger = new FakeLogger();
    const starts: string[] = [];
    const result = await provisionOllamaEmbeddingBackend({
      fetch: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      },
      logger,
      runOllamaVersion: async () => {
        const error = new Error('spawn ollama ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      startOllama: ({ binary }) => {
        starts.push(binary);
        return fakeDaemon();
      },
    });

    expect(result).toEqual({
      ready: false,
      host: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
      reason: '`ollama` binary not found on PATH',
    });
    expect(starts).toEqual([]);
    expect(logger.warnings).toEqual([
      [
        'Ollama is not reachable at http://127.0.0.1:11434 and the `ollama` binary is not on PATH. Install Ollama or set OLLAMA_HOST; learning-loop archetype clustering is disabled for this worker session.',
      ],
    ]);
  });
});

function tagsResponse(models: string[]): Response {
  return new Response(
    JSON.stringify({
      models: models.map((name) => ({ name })),
    }),
    { status: 200 },
  );
}

function fakeDaemon() {
  return {
    on() {
      return this;
    },
    unref() {},
  };
}

class FakeLogger {
  readonly infos: string[] = [];
  readonly warnings: unknown[][] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(...args: unknown[]): void {
    this.warnings.push(args);
  }
}
