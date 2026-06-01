import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');

  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn(),
  };
});

import { provisionOllamaEmbeddingBackend } from './ollama-provisioner.js';

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

describe('provisionOllamaEmbeddingBackend default daemon start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts ollama serve with the resolved OLLAMA_HOST', async () => {
    mockExecFile.mockImplementation(((binary, args, callback) => {
      expect(binary).toBe('ollama');
      expect(args).toEqual(['--version']);
      callback?.(null, '', '');
      return fakeDaemon();
    }) as typeof execFile);
    mockSpawn.mockReturnValue(fakeDaemon());

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
      sleep: async () => {},
    });

    expect(result.ready).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'ollama',
      ['serve'],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ OLLAMA_HOST: 'http://127.0.0.1:11555' }),
        stdio: 'ignore',
      }),
    );
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
