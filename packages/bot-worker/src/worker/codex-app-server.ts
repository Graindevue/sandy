import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const RPC_TIMEOUT_MS = 10_000;

export function protocolObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Invalid Codex ${label}`);
  return value as Record<string, unknown>;
}

export function runtimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'USER',
    'LOGNAME',
    'SHELL',
  ]) {
    if (env[key] !== undefined) safe[key] = env[key];
  }
  return safe;
}

/** The subprocess is the protocol boundary; request ids and thread ids have separate owners. */
export class CodexAppServer {
  readonly failure = new AbortController();
  readonly #child: ReturnType<typeof spawn>;
  readonly #closed: Promise<void>;
  readonly #pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  #nextId = 0;
  #buffer = '';
  #stderr = '';
  #bytes = 0;
  #closing = false;
  #termination: Promise<void> | undefined;
  onNotification: ((method: string, params: Record<string, unknown>) => void) | undefined;

  constructor(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.#child = spawn(
      executable,
      [
        'app-server',
        '--listen',
        'stdio://',
        '--strict-config',
        '-c',
        'cli_auth_credentials_store="file"',
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'features.shell_snapshot=false',
        '-c',
        'features.multi_agent=false',
      ],
      {
        cwd,
        env,
        stdio: 'pipe',
        detached: true,
      },
    );
    this.#closed = new Promise((resolve) => {
      this.#child.once('close', (code) => {
        if (this.#buffer.trim() !== '') this.#read(this.#buffer);
        if (!this.#closing) this.fail(new Error(`Codex app-server exited unexpectedly (${code})`));
        resolve();
      });
    });
    this.#child.once('error', (error) => this.fail(error));
    this.#child.stdin?.on('error', (error) => {
      if (!this.#closing) this.fail(error);
    });
    this.#child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    this.#child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      this.#bytes += Buffer.byteLength(chunk);
      if (this.#bytes > 64 * 1024 * 1024)
        return this.fail(new Error('Codex app-server output exceeds 64MiB'));
      const lines = (this.#buffer + chunk).split('\n');
      this.#buffer = lines.pop() ?? '';
      if (this.#buffer.length > 4 * 1024 * 1024)
        return this.fail(new Error('Codex app-server line exceeds 4MiB'));
      for (const line of lines) if (line.trim() !== '') this.#read(line);
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'sandy-review', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.#send({ method: 'initialized', params: {} });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.failure.signal.throwIfAborted();
    if (this.#closing) return Promise.reject(new Error('Codex runtime closed'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex ${method} response timed out`));
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ id, method, params });
    });
  }

  fail(error: Error): void {
    if (this.failure.signal.aborted) return;
    this.failure.abort(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    void this.#terminate();
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#child.stdin?.end();
    const timer = setTimeout(() => void this.#terminate(), 1000);
    try {
      await this.#closed;
      await this.#termination;
    } finally {
      clearTimeout(timer);
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Codex runtime closed'));
      }
      this.#pending.clear();
      this.#stderr = '';
    }
  }

  #send(value: Record<string, unknown>): void {
    this.#child.stdin?.write(`${JSON.stringify(value)}\n`);
  }

  #read(line: string): void {
    try {
      const value = protocolObject(JSON.parse(line), 'protocol message');
      if (
        typeof value.id === 'number' &&
        this.#pending.has(value.id) &&
        value.method === undefined
      ) {
        const pending = this.#pending.get(value.id);
        if (pending === undefined) return;
        if (value.error !== undefined) {
          const error = protocolObject(value.error, 'RPC error');
          this.#pending.delete(value.id);
          clearTimeout(pending.timer);
          pending.reject(
            new Error(typeof error.message === 'string' ? error.message : 'Codex request failed'),
          );
        } else {
          const result = protocolObject(value.result, 'RPC result');
          this.#pending.delete(value.id);
          clearTimeout(pending.timer);
          pending.resolve(result);
        }
      } else if (typeof value.method === 'string') {
        if (value.id !== undefined) {
          // Reviews never approve escalation, interactive input, or external-auth replacement.
          this.#send({
            id: value.id,
            error: {
              code: -32601,
              message: 'Interactive server requests are disabled for Sandy reviews',
            },
          });
        } else
          this.onNotification?.(value.method, protocolObject(value.params ?? {}, 'notification'));
      } else throw new Error('Unrecognized Codex protocol message');
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Invalid Codex protocol'));
    }
  }

  #terminate(): Promise<void> {
    if (this.#termination !== undefined) return this.#termination;
    this.#termination = (async () => {
      const pid = this.#child.pid;
      if (pid === undefined) return;
      const descendants = new Set<number>([pid]);
      try {
        const { stdout } = await exec('ps', ['-axo', 'pid=,ppid='], {
          env: runtimeEnvironment(process.env),
          timeout: 1000,
        });
        const rows = stdout
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/).map(Number));
        let changed = true;
        while (changed) {
          changed = false;
          for (const [child, parent] of rows) {
            if (
              child !== undefined &&
              parent !== undefined &&
              descendants.has(parent) &&
              !descendants.has(child)
            ) {
              descendants.add(child);
              changed = true;
            }
          }
        }
      } catch {
        /* A process-group kill still covers ordinary descendants. */
      }
      const kill = (signal: NodeJS.Signals) => {
        for (const child of [...descendants].reverse()) {
          try {
            process.kill(child === pid ? -pid : child, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      };
      kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 250));
      kill('SIGKILL');
    })();
    return this.#termination;
  }
}
