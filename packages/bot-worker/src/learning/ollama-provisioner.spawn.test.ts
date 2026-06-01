import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');

  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { provisionOllamaEmbeddingBackend } from './ollama-provisioner.js';

const mockSpawn = vi.mocked(spawn);

describe('provisionOllamaEmbeddingBackend default daemon start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts ollama serve with the resolved OLLAMA_HOST and inherited environment', async () => {
    mockSpawn.mockReturnValue(fakeDaemon());
    const passthroughKey = 'SANDY_OLLAMA_PROVISIONER_TEST';
    const previousPassthroughValue = process.env[passthroughKey];
    process.env[passthroughKey] = 'preserved';

    try {
      let tagsAttempts = 0;
      const result = await provisionOllamaEmbeddingBackend({
        host: 'http://127.0.0.1:11555/',
        fetch: async (input) => {
          expect(input).toBe('http://127.0.0.1:11555/api/tags');
          tagsAttempts += 1;
          if (tagsAttempts === 1) {
            throw new Error('connect ECONNREFUSED 127.0.0.1:11555');
          }
          return tagsResponse(['nomic-embed-text:latest']);
        },
        logger: new FakeLogger(),
        retryDelaysMs: [1],
        runOllamaVersion: async () => {},
        sleep: async () => {},
      });

      expect(result.ready).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        'ollama',
        ['serve'],
        expect.objectContaining({
          detached: true,
          env: expect.objectContaining({
            OLLAMA_HOST: 'http://127.0.0.1:11555',
            [passthroughKey]: 'preserved',
          }),
          stdio: 'ignore',
        }),
      );
    } finally {
      if (previousPassthroughValue === undefined) {
        delete process.env[passthroughKey];
      } else {
        process.env[passthroughKey] = previousPassthroughValue;
      }
    }
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

function fakeDaemon(): ChildProcess {
  const daemon = new EventEmitter() as ChildProcess;
  daemon.unref = vi.fn();
  return daemon;
}

class FakeLogger {
  info(): void {}

  warn(): void {}
}
