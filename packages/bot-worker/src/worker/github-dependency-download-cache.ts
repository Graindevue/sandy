import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DependencyDownloadCache,
  DependencyDownloadCacheInput,
} from './dependency-download-cache.js';

const worker = `
  const cache = require(process.argv[1]);
  const [operation, key, path] = process.argv.slice(2);
  (async () => {
    if (!cache.isFeatureAvailable()) throw new Error('Cache service unavailable');
    const result = operation === 'restore'
      ? await cache.restoreCache([path], key, [], { timeoutInMs: 25000 })
      : await cache.saveCache([path], key);
    if (operation === 'save' && !(result >= 0)) throw new Error('Cache not saved');
    console.log('SANDY_CACHE_RESULT:' + JSON.stringify(result ?? null));
  })().catch(() => { process.exitCode = 1; });
`;

/** SDK workers keep cache-service stalls and archive subprocesses inside a bounded lifecycle. */
export function createGitHubDependencyDownloadCache(
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): DependencyDownloadCache {
  const modulePath = createRequire(import.meta.url).resolve('@actions/cache');
  const operation = (
    kind: 'restore' | 'save',
    input: DependencyDownloadCacheInput,
  ): Promise<string | undefined> => {
    input.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['-e', worker, modulePath, kind, input.key, input.storePath],
        {
          cwd: dirname(fileURLToPath(import.meta.url)),
          env: options.env ?? process.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      let stdout = '';
      let failure: unknown;
      const stop = (reason: unknown) => {
        failure ??= reason;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = error;
          }
        }
      };
      const timeout = setTimeout(
        () => stop(new Error('Dependency cache operation timed out')),
        options.timeoutMs ?? 30_000,
      );
      const abort = () =>
        stop(input.signal?.reason ?? new Error('Dependency cache operation cancelled'));
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-8192);
      });
      child.once('error', (error) => {
        failure = error;
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', abort);
        if (failure !== undefined) reject(failure);
        else if (code !== 0) reject(new Error('Dependency cache service unavailable'));
        else {
          try {
            const result = stdout
              .split('\n')
              .findLast((line) => line.startsWith('SANDY_CACHE_RESULT:'));
            if (result === undefined) throw new Error('Missing cache result');
            const value: unknown = JSON.parse(result.slice('SANDY_CACHE_RESULT:'.length));
            resolve(typeof value === 'string' ? value : undefined);
          } catch {
            reject(new Error('Invalid dependency cache service response'));
          }
        }
      });
    });
  };
  return {
    restore: (input) => operation('restore', input),
    save: async (input) => {
      await operation('save', input);
    },
  };
}
