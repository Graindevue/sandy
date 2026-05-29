/**
 * Tests for the Apple Container SandboxProvider. Originally developed for
 * graindevue's sandcastle integration; copied into Sandy per ADR 0009. Unit
 * tests mock `node:child_process`; the integration block is gated behind
 * `SANDCASTLE_INTEGRATION=1` and skipped by default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');

  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';

import type { BindMountCreateOptions, BindMountSandboxHandle } from '@ai-hero/sandcastle';

import { appleContainer, cleanupOrphanedAppleContainers } from './apple-container.js';

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

type FakeProcOptions = {
  /** Bytes emitted on stdout before close. */
  stdout?: Buffer | string;
  /** Bytes emitted on stderr before close. */
  stderr?: Buffer | string;
  /** Exit code; null + non-null signal models a signal kill. */
  exitCode?: number | null;
  /** POSIX signal name, or null for a normal exit. */
  signal?: NodeJS.Signals | null;
};

/**
 * Fake `child_process.spawn` result that drains stdin, emits the given stdout
 * bytes, then fires 'close' with the requested exit/signal pair. Returned cast
 * as ChildProcess so the production code's typed access works without changes.
 */
const fakeProc = (opts: FakeProcOptions = {}): ChildProcess => {
  const proc = new EventEmitter() as unknown as ChildProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  // Cast the mock onto the real `kill` signature; vi.fn() returns a Mock that
  // doesn't structurally match `(signal?: number | Signals) => boolean`.
  (proc as { kill: ChildProcess['kill'] }).kill = vi.fn() as unknown as ChildProcess['kill'];

  // Drain anything piped into us so input.pipe(proc.stdin) does not stall.
  proc.stdin.resume();

  process.nextTick(() => {
    proc.stdout.end(opts.stdout ?? '');
    proc.stderr.end(opts.stderr ?? '');
  });

  setImmediate(() => {
    // Use `in` so callers can pass exitCode: null to model a signal kill —
    // `?? 0` would coerce explicit null back to 0 and mask the bug we test.
    const code = 'exitCode' in opts ? opts.exitCode : 0;
    proc.emit('close', code, opts.signal ?? null);
  });

  return proc;
};

const imageInspectJson = (user: string) => JSON.stringify([{ config: { User: user } }]);

afterEach(() => {
  mockExecFile.mockReset();
  mockSpawn.mockReset();
});

const mockCreateFlow = (imageUser?: string) => {
  const hostUid = process.getuid?.() ?? 1000;
  const hostGid = process.getgid?.() ?? 1000;
  const user = imageUser ?? `${hostUid}:${hostGid}`;

  mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;

    if (!Array.isArray(args)) {
      callback(null, '', '');
      return undefined as never;
    }

    if (args[0] === 'system' && args[1] === 'status') {
      callback(null, 'ok', '');
    } else if (args[0] === 'image' && args[1] === 'inspect') {
      callback(null, imageInspectJson(user), '');
    } else if (args[0] === 'run') {
      callback(null, '', '');
    } else {
      callback(null, '', '');
    }

    return undefined as never;
  });
};

describe('appleContainer()', () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'apple-container'", () => {
    const provider = appleContainer();
    expect(provider.tag).toBe('bind-mount');
    expect(provider.name).toBe('apple-container');
  });

  it('accepts an env option', () => {
    const provider = appleContainer({ env: { MY_VAR: 'hello' } });
    expect(provider.env).toEqual({ MY_VAR: 'hello' });
  });

  it('defaults env to empty object when not provided', () => {
    const provider = appleContainer();
    expect(provider.env).toEqual({});
  });

  it('throws at construction time if a mount hostPath does not exist', () => {
    expect(() =>
      appleContainer({
        mounts: [
          {
            hostPath: '/nonexistent/path/does/not/exist',
            sandboxPath: '/mnt/cache',
          },
        ],
      }),
    ).toThrow('Mount hostPath does not exist');
  });

  it('expands tilde in mount hostPath at construction time', () => {
    const provider = appleContainer({
      mounts: [{ hostPath: '~', sandboxPath: '/mnt/home', readonly: true }],
    });
    expect(provider.tag).toBe('bind-mount');
  });

  it('resolves relative hostPath against process.cwd()', () => {
    // Use a relative path to an always-present directory (the OS temp dir) so
    // the test is independent of the directory vitest runs from.
    const relativeToTmp = relative(process.cwd(), tmpdir());
    const provider = appleContainer({
      mounts: [{ hostPath: relativeToTmp, sandboxPath: '/mnt/rel' }],
    });
    expect(provider.tag).toBe('bind-mount');
  });

  it('throws for relative hostPath that does not exist', () => {
    expect(() =>
      appleContainer({
        mounts: [{ hostPath: 'nonexistent_dir_xyz', sandboxPath: '/mnt/data' }],
      }),
    ).toThrow('Mount hostPath does not exist');
  });

  it('throws at construction time for file mount with parent outside /home/agent', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-test-'));
    const tmpFile = join(tmpDir, 'config.json');
    writeFileSync(tmpFile, '{}');

    expect(() =>
      appleContainer({
        mounts: [{ hostPath: tmpFile, sandboxPath: '/opt/foo/config.json' }],
      }),
    ).toThrow(/outside the sandbox home directory/);

    unlinkSync(tmpFile);
    rmdirSync(tmpDir);
  });

  it('rejects a file mount whose sandboxPath escapes home via ".."', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-test-'));
    const tmpFile = join(tmpDir, 'config.json');
    writeFileSync(tmpFile, '{}');

    expect(() =>
      appleContainer({
        mounts: [{ hostPath: tmpFile, sandboxPath: '/home/agent/../etc/evil.json' }],
      }),
    ).toThrow(/outside the sandbox home directory/);

    unlinkSync(tmpFile);
    rmdirSync(tmpDir);
  });

  it('bounds container CLI calls with a timeout', async () => {
    mockCreateFlow();
    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });
    await handle.close();

    expect(mockExecFile.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockExecFile.mock.calls) {
      const options = call.find(
        (arg) => typeof arg === 'object' && arg !== null && 'timeout' in arg,
      ) as { timeout?: number } | undefined;
      expect(typeof options?.timeout).toBe('number');
    }
  });

  it('bounds the synchronous exit-path cleanup with a timeout', async () => {
    const mockExecFileSync = vi.mocked(execFileSync);
    mockExecFileSync.mockReset();
    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-test-'));
    const tmpFile = join(tmpDir, 'config.json');
    writeFileSync(tmpFile, '{}');

    // A file mount under home forces a parent-dir `mkdir` exec; failing it drives
    // create() down the setup-error path, which runs the synchronous cleanup.
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      if (!Array.isArray(args)) {
        callback(null, '', '');
        return undefined as never;
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        const uid = process.getuid?.() ?? 1000;
        const gid = process.getgid?.() ?? 1000;
        callback(null, imageInspectJson(`${uid}:${gid}`), '');
      } else if (args[0] === 'exec') {
        callback(new Error('mkdir failed'), '', '');
      } else {
        callback(null, '', '');
      }
      return undefined as never;
    });

    const provider = appleContainer({
      mounts: [{ hostPath: tmpFile, sandboxPath: '/home/agent/cfg/config.json' }],
    });
    await expect(
      provider.create({
        worktreePath: '/tmp/worktree',
        hostRepoPath: '/tmp/repo',
        mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
        env: {},
      }),
    ).rejects.toThrow();

    expect(mockExecFileSync).toHaveBeenCalled();
    const opts = mockExecFileSync.mock.calls.at(-1)?.[2] as { timeout?: number } | undefined;
    expect(typeof opts?.timeout).toBe('number');

    unlinkSync(tmpFile);
    rmdirSync(tmpDir);
  });

  it('runs pre-flight system status then image inspect then run', async () => {
    const callOrder: string[] = [];
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (!Array.isArray(args)) {
        callback(null, '', '');
        return undefined as never;
      }

      if (args[0] === 'system' && args[1] === 'status') {
        callOrder.push('system-status');
        callback(null, '', '');
      } else if (args[0] === 'image' && args[1] === 'inspect') {
        callOrder.push('image-inspect');
        const hostUid = process.getuid?.() ?? 1000;
        const hostGid = process.getgid?.() ?? 1000;
        callback(null, imageInspectJson(`${hostUid}:${hostGid}`), '');
      } else if (args[0] === 'run') {
        callOrder.push('run');
        callback(null, '', '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    expect(callOrder).toEqual(['system-status', 'image-inspect', 'run']);
    await handle.close();
  });

  it('auto-starts the system when status fails', async () => {
    const callOrder: string[] = [];
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (!Array.isArray(args)) {
        callback(null, '', '');
        return undefined as never;
      }

      if (args[0] === 'system' && args[1] === 'status') {
        callOrder.push('system-status');
        callback(new Error('not running'), '', '');
      } else if (args[0] === 'system' && args[1] === 'start') {
        callOrder.push('system-start');
        callback(null, '', '');
      } else if (args[0] === 'image' && args[1] === 'inspect') {
        const hostUid = process.getuid?.() ?? 1000;
        const hostGid = process.getgid?.() ?? 1000;
        callback(null, imageInspectJson(`${hostUid}:${hostGid}`), '');
      } else if (args[0] === 'run') {
        callback(null, '', '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    expect(callOrder).toEqual(['system-status', 'system-start']);
    await handle.close();
  });

  it('throws on UID mismatch between image and host', async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (Array.isArray(args) && args[0] === 'system' && args[1] === 'status') {
        callback(null, '', '');
      } else if (Array.isArray(args) && args[0] === 'image' && args[1] === 'inspect') {
        callback(null, imageInspectJson('9999:9999'), '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });

    const provider = appleContainer();

    await expect(
      provider.create({
        worktreePath: '/tmp/worktree',
        hostRepoPath: '/tmp/repo',
        mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
        env: {},
      }),
    ).rejects.toThrow('UID mismatch');
  });

  it('throws a parseable error when image-inspect stdout is not JSON (F5)', async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (Array.isArray(args) && args[0] === 'system' && args[1] === 'status') {
        callback(null, '', '');
      } else if (Array.isArray(args) && args[0] === 'image' && args[1] === 'inspect') {
        // Simulate a future CLI banner / non-JSON noise on stdout.
        callback(null, 'WARNING: experimental container CLI banner\n', '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });

    const provider = appleContainer();

    await expect(
      provider.create({
        worktreePath: '/tmp/worktree',
        hostRepoPath: '/tmp/repo',
        mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
        env: {},
      }),
    ).rejects.toThrow(/Could not parse 'container image inspect.*output \(rebuild the image with/);
  });

  it('throws when worktreePath has no matching mount (F7 — no silent fallback)', async () => {
    mockCreateFlow();

    const provider = appleContainer();
    await expect(
      provider.create({
        worktreePath: '/tmp/worktree-not-in-mounts',
        hostRepoPath: '/tmp/repo',
        mounts: [
          // Note: hostPath here intentionally does NOT match worktreePath.
          { hostPath: '/tmp/other', sandboxPath: '/home/agent/workspace' },
        ],
        env: {},
      }),
    ).rejects.toThrow(
      /Could not locate sandbox path for worktree '\/tmp\/worktree-not-in-mounts'.*\/tmp\/other/,
    );
  });

  it('throws when the image has no USER directive (F6 — refuses root)', async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (Array.isArray(args) && args[0] === 'system' && args[1] === 'status') {
        callback(null, '', '');
      } else if (Array.isArray(args) && args[0] === 'image' && args[1] === 'inspect') {
        callback(null, imageInspectJson(''), '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });

    const provider = appleContainer();

    await expect(
      provider.create({
        worktreePath: '/tmp/worktree',
        hostRepoPath: '/tmp/repo',
        mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
        env: {},
      }),
    ).rejects.toThrow(/no USER directive — refusing to run as root/);
  });

  it('throws when the image USER is non-numeric (F6 — Dockerfile uses USER agent)', async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (Array.isArray(args) && args[0] === 'system' && args[1] === 'status') {
        callback(null, '', '');
      } else if (Array.isArray(args) && args[0] === 'image' && args[1] === 'inspect') {
        callback(null, imageInspectJson('agent'), '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });

    const provider = appleContainer();

    await expect(
      provider.create({
        worktreePath: '/tmp/worktree',
        hostRepoPath: '/tmp/repo',
        mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
        env: {},
      }),
    ).rejects.toThrow(
      /Cannot verify UID for image.*USER is declared as 'agent', not a numeric UID/,
    );
  });

  it('containerUid override bypasses UID mismatch with host', async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (Array.isArray(args) && args[0] === 'system' && args[1] === 'status') {
        callback(null, '', '');
      } else if (Array.isArray(args) && args[0] === 'image' && args[1] === 'inspect') {
        callback(null, imageInspectJson('500:500'), '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });

    const provider = appleContainer({ containerUid: 500, containerGid: 500 });
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === 'run',
    );
    expect(runCall).toBeDefined();
    await handle.close();
  });

  it('throws a clear error when image is not found locally', async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (Array.isArray(args) && args[0] === 'system' && args[1] === 'status') {
        callback(null, '', '');
      } else if (Array.isArray(args) && args[0] === 'image' && args[1] === 'inspect') {
        callback(new Error('no such image'), '', '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });

    const provider = appleContainer({ imageName: 'my-app:latest' });

    await expect(
      provider.create({
        worktreePath: '/tmp/worktree',
        hostRepoPath: '/tmp/repo',
        mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
        env: {},
      }),
    ).rejects.toThrow(
      "Image 'my-app:latest' not found locally. Build it first with 'pnpm sandcastle:build-image'.",
    );
  });

  it('uses host UID/GID by default for --user flag', async () => {
    mockCreateFlow();

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === 'run',
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain('--dns');
    expect(runArgs).toContain('1.1.1.1');
    expect(runArgs).toContain('8.8.8.8');
    expect(runArgs).toContain('--memory');
    expect(runArgs).toContain('8g');
    expect(runArgs).toContain('--cpus');
    expect(runArgs).toContain('4');
    const userIdx = runArgs.indexOf('--user');
    expect(userIdx).toBeGreaterThan(-1);
    const hostUid = process.getuid?.() ?? 1000;
    const hostGid = process.getgid?.() ?? 1000;
    expect(runArgs[userIdx + 1]).toBe(`${hostUid}:${hostGid}`);

    await handle.close();
  });

  it('copyFileIn uses `container exec -i ... cat > "$1"` instead of `container cp`', async () => {
    // F1 regression test: `container cp` does not exist on installed v0.12.3,
    // so the implementation must reach for `exec` and stream over stdin.
    mockCreateFlow();
    mockSpawn.mockImplementation(() => fakeProc({ exitCode: 0 }));

    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-copy-in-'));
    const srcFile = join(tmpDir, 'src.bin');
    writeFileSync(srcFile, Buffer.from([0, 1, 2, 0xff]));

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const bmHandle = handle as BindMountSandboxHandle;
    await bmHandle.copyFileIn(srcFile, '/sandbox/file.bin');

    const cpCall = mockExecFile.mock.calls.find(
      ([cmd, args]) => cmd === 'container' && Array.isArray(args) && args[0] === 'cp',
    );
    expect(cpCall, 'must not invoke unsupported `container cp`').toBeUndefined();

    const copySpawn = mockSpawn.mock.calls.find(([cmd, args]) => {
      if (cmd !== 'container' || !Array.isArray(args)) return false;
      return args[0] === 'exec' && args.includes('-i') && args.includes('cat > "$1"');
    });
    expect(copySpawn).toBeDefined();
    const spawnArgs = copySpawn![1] as string[];
    expect(spawnArgs).toEqual(
      expect.arrayContaining([
        'exec',
        '-i',
        expect.stringMatching(/^sandcastle-/),
        'sh',
        '-c',
        'cat > "$1"',
        'sh',
        '/sandbox/file.bin',
      ]),
    );

    rmSync(tmpDir, { recursive: true, force: true });
    await handle.close();
  });

  it('copyFileOut uses `container exec ... cat -- "$1"` and writes bytes to host file', async () => {
    // F1 regression test: stream stdout to the host path, no `container cp`.
    mockCreateFlow();
    const payload = Buffer.from('hello from sandbox\n');
    mockSpawn.mockImplementation(() => fakeProc({ stdout: payload, exitCode: 0 }));

    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-copy-out-'));
    const dstFile = join(tmpDir, 'dst.bin');

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const bmHandle = handle as BindMountSandboxHandle;
    await bmHandle.copyFileOut('/sandbox/output.txt', dstFile);

    const cpCall = mockExecFile.mock.calls.find(
      ([cmd, args]) => cmd === 'container' && Array.isArray(args) && args[0] === 'cp',
    );
    expect(cpCall, 'must not invoke unsupported `container cp`').toBeUndefined();

    const copySpawn = mockSpawn.mock.calls.find(([cmd, args]) => {
      if (cmd !== 'container' || !Array.isArray(args)) return false;
      return args[0] === 'exec' && args.includes('cat -- "$1"');
    });
    expect(copySpawn).toBeDefined();
    const spawnArgs = copySpawn![1] as string[];
    expect(spawnArgs).toContain('/sandbox/output.txt');
    expect(spawnArgs).not.toContain('-i');

    expect(readFileSync(dstFile)).toEqual(payload);

    rmSync(tmpDir, { recursive: true, force: true });
    await handle.close();
  });

  it('copyFileOut leaves an existing host file intact when the copy fails', async () => {
    mockCreateFlow();
    // Non-zero exit after streaming begins — the copy fails mid-flight.
    mockSpawn.mockImplementation(() => fakeProc({ stdout: Buffer.from('partial'), exitCode: 1 }));

    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-copy-out-'));
    const dstFile = join(tmpDir, 'dst.bin');
    const original = Buffer.from('original host contents\n');
    writeFileSync(dstFile, original);

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });
    const bmHandle = handle as BindMountSandboxHandle;

    await expect(bmHandle.copyFileOut('/sandbox/output.txt', dstFile)).rejects.toThrow(
      /copyFileOut/,
    );
    // The pre-existing file is untouched, and no temp file is left behind.
    expect(readFileSync(dstFile)).toEqual(original);
    expect(readdirSync(tmpDir)).toEqual(['dst.bin']);

    rmSync(tmpDir, { recursive: true, force: true });
    await handle.close();
  });

  it('runs mkdir+chown for file mount parent dirs after container start', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-test-'));
    const tmpFile = join(tmpDir, 'auth.json');
    writeFileSync(tmpFile, '{}');

    mockCreateFlow();

    const provider = appleContainer({
      mounts: [{ hostPath: tmpFile, sandboxPath: '/home/agent/.codex/auth.json' }],
    });
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const mkdirCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === 'container' &&
        Array.isArray(args) &&
        args[0] === 'exec' &&
        args.some(
          (a: string) => typeof a === 'string' && a.includes('mkdir') && a.includes('chown'),
        ),
    );
    expect(mkdirCall).toBeDefined();
    const mkdirArgs = mkdirCall![1] as string[];
    expect(mkdirArgs).toContain('--user');
    expect(mkdirArgs[mkdirArgs.indexOf('--user') + 1]).toBe('0:0');
    expect(mkdirArgs).toContain('/home/agent/.codex');

    unlinkSync(tmpFile);
    rmdirSync(tmpDir);
    await handle.close();
  });

  it('does not run mkdir+chown when there are no file mounts', async () => {
    mockCreateFlow();

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const mkdirCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === 'container' &&
        Array.isArray(args) &&
        args[0] === 'exec' &&
        args.some((a: string) => typeof a === 'string' && a.includes('mkdir')),
    );
    expect(mkdirCall).toBeUndefined();

    await handle.close();
  });

  it('copyFileIn rejects with stderr context when the in-container shell exits non-zero', async () => {
    mockCreateFlow();
    mockSpawn.mockImplementation(() =>
      fakeProc({
        exitCode: 1,
        stderr: "sh: can't create /sandbox/file.txt: Permission denied",
      }),
    );

    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-copy-fail-'));
    const srcFile = join(tmpDir, 'src');
    writeFileSync(srcFile, 'data');

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const bmHandle = handle as BindMountSandboxHandle;
    await expect(bmHandle.copyFileIn(srcFile, '/sandbox/file.txt')).rejects.toThrow(
      /copyFileIn into '\/sandbox\/file\.txt' failed \(exit 1\).*Permission denied/,
    );

    rmSync(tmpDir, { recursive: true, force: true });
    await handle.close();
  });

  it('copyFileIn rejects when the host file cannot be read', async () => {
    mockCreateFlow();
    mockSpawn.mockImplementation(() => fakeProc({ exitCode: 0 }));

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const bmHandle = handle as BindMountSandboxHandle;
    await expect(
      bmHandle.copyFileIn('/this/path/does/not/exist/anywhere', '/sandbox/file.txt'),
    ).rejects.toThrow(/copyFileIn read of/);

    await handle.close();
  });

  it('copyFileOut rejects with stderr context when the in-container shell exits non-zero', async () => {
    mockCreateFlow();
    mockSpawn.mockImplementation(() =>
      fakeProc({ exitCode: 1, stderr: 'cat: /no/such: No such file' }),
    );

    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-container-copy-out-fail-'));
    const dstFile = join(tmpDir, 'dst');

    const provider = appleContainer();
    const handle = await provider.create({
      worktreePath: '/tmp/worktree',
      hostRepoPath: '/tmp/repo',
      mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
      env: {},
    });

    const bmHandle = handle as BindMountSandboxHandle;
    await expect(bmHandle.copyFileOut('/no/such', dstFile)).rejects.toThrow(
      /copyFileOut of '\/no\/such' failed \(exit 1\).*No such file/,
    );

    rmSync(tmpDir, { recursive: true, force: true });
    await handle.close();
  });
});

describe('appleContainer() — signal-killed exit (F2)', () => {
  const createOptions: BindMountCreateOptions = {
    worktreePath: '/tmp/worktree',
    hostRepoPath: '/tmp/repo',
    mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
    env: {},
  };

  it('exec() surfaces a SIGKILL as exit code 137 and notes the signal in stderr', async () => {
    mockCreateFlow();
    mockSpawn.mockImplementation(() =>
      fakeProc({ exitCode: null, signal: 'SIGKILL', stderr: 'oom-killer' }),
    );

    const provider = appleContainer();
    const handle = await provider.create(createOptions);
    const result = await handle.exec('pnpm type-check');

    // SIGKILL is signal 9 → POSIX shell-style exit code 128+9
    expect(result.exitCode).toBe(137);
    expect(result.stderr).toContain('SIGKILL');
    expect(result.stderr).toContain('oom-killer');

    await handle.close();
  });

  it('interactiveExec() surfaces a SIGTERM as exit code 143', async () => {
    mockCreateFlow();
    mockSpawn.mockImplementation(() => fakeProc({ exitCode: null, signal: 'SIGTERM' }));

    const provider = appleContainer();
    const handle = await provider.create(createOptions);
    if (!handle.interactiveExec) {
      throw new Error('handle.interactiveExec is required for this test');
    }
    const result = await handle.interactiveExec(['sh'], {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    expect(result.exitCode).toBe(143);

    await handle.close();
  });
});

describe('appleContainer() — module-level signal handling (F3)', () => {
  /*
   * Helper: drive create() while capturing the container name from the
   * `--name` flag in the `container run` call, so signal-handler tests can
   * assert which containers got cleaned up.
   */
  const mockCreateFlowTracking = () => {
    const names: string[] = [];
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (!Array.isArray(args)) {
        callback(null, '', '');
        return undefined as never;
      }

      if (args[0] === 'system' && args[1] === 'status') {
        callback(null, 'ok', '');
      } else if (args[0] === 'image' && args[1] === 'inspect') {
        const hostUid = process.getuid?.() ?? 1000;
        const hostGid = process.getgid?.() ?? 1000;
        callback(null, imageInspectJson(`${hostUid}:${hostGid}`), '');
      } else if (args[0] === 'run') {
        const nameIdx = args.indexOf('--name');
        if (nameIdx > -1) names.push(args[nameIdx + 1] as string);
        callback(null, '', '');
      } else {
        callback(null, '', '');
      }

      return undefined as never;
    });
    return { names };
  };

  const createOptions: BindMountCreateOptions = {
    worktreePath: '/tmp/worktree',
    hostRepoPath: '/tmp/repo',
    mounts: [{ hostPath: '/tmp/worktree', sandboxPath: '/home/agent/workspace' }],
    env: {},
  };

  it('does not add a new signal listener per create() call', async () => {
    mockCreateFlowTracking();
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const exitBefore = process.listenerCount('exit');

    const provider = appleContainer();
    const handles = await Promise.all([
      provider.create(createOptions),
      provider.create(createOptions),
      provider.create(createOptions),
    ]);

    // At most one new listener regardless of how many sandboxes are open.
    expect(process.listenerCount('SIGINT') - sigintBefore).toBeLessThanOrEqual(1);
    expect(process.listenerCount('SIGTERM') - sigtermBefore).toBeLessThanOrEqual(1);
    expect(process.listenerCount('exit') - exitBefore).toBeLessThanOrEqual(1);

    await Promise.all(handles.map((h) => h.close()));
  });

  it('SIGTERM handler deletes every active sandbox and exits with 128+15', async () => {
    const { names } = mockCreateFlowTracking();

    const provider = appleContainer();
    const handles = await Promise.all([
      provider.create(createOptions),
      provider.create(createOptions),
    ]);
    expect(names).toHaveLength(2);

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => code as never) as never);

    const sigtermListeners = process.listeners('SIGTERM');
    // The module installs its handler the first time create() runs, and it is
    // appended to whatever was there before. Pick it up from the end.
    const handler = sigtermListeners[sigtermListeners.length - 1] as (sig: NodeJS.Signals) => void;
    expect(typeof handler).toBe('function');

    const deletesBefore = mockExecFile.mock.calls.filter(
      ([cmd, a]) => cmd === 'container' && Array.isArray(a) && a[0] === 'delete',
    ).length;

    handler('SIGTERM');

    // Yield for async delete kick-off + Promise.allSettled tick.
    await new Promise((r) => setTimeout(r, 20));

    const deletesAfter = mockExecFile.mock.calls.filter(
      ([cmd, a]) => cmd === 'container' && Array.isArray(a) && a[0] === 'delete',
    ).length;
    expect(deletesAfter - deletesBefore).toBeGreaterThanOrEqual(2);

    expect(exitSpy).toHaveBeenCalledWith(143);

    exitSpy.mockRestore();
    // Handles are intentionally not closed: the signal handler already
    // removed them from the active-name set, and close() would issue
    // redundant deletes.
    void handles;
  });

  it('close() removes the container from the active-name set', async () => {
    const { names } = mockCreateFlowTracking();

    const provider = appleContainer();
    const handle = await provider.create(createOptions);
    expect(names).toHaveLength(1);

    await handle.close();

    // Fire the signal handler now — no deletes should be attempted because
    // the only container we created has been removed from the active set.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => code as never) as never);

    const sigtermListeners = process.listeners('SIGTERM');
    const handler = sigtermListeners[sigtermListeners.length - 1] as (sig: NodeJS.Signals) => void;

    const deletesBefore = mockExecFile.mock.calls.filter(
      ([cmd, a]) => cmd === 'container' && Array.isArray(a) && a[0] === 'delete',
    ).length;

    handler('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));

    const deletesAfter = mockExecFile.mock.calls.filter(
      ([cmd, a]) => cmd === 'container' && Array.isArray(a) && a[0] === 'delete',
    ).length;
    // close() already deleted; signal handler should add zero new deletes.
    expect(deletesAfter - deletesBefore).toBe(0);

    exitSpy.mockRestore();
  });
});

describe('cleanupOrphanedAppleContainers()', () => {
  it('deletes only containers matching the configured name prefix', async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;

      if (!Array.isArray(args)) {
        callback(null, '', '');
        return undefined as never;
      }

      if (args[0] === 'list') {
        callback(
          null,
          JSON.stringify([
            { configuration: { id: 'sandy-worker-old-running' }, status: 'running' },
            { id: 'sandy-worker-old-stopped', status: 'stopped' },
            { configuration: { id: 'sandcastle-other-agent' }, status: 'running' },
            { configuration: { id: 'buildkit' }, status: 'running' },
          ]),
          '',
        );
        return undefined as never;
      }

      callback(null, '', '');
      return undefined as never;
    });

    const result = await cleanupOrphanedAppleContainers({ namePrefix: 'sandy-worker-' });

    expect(result).toEqual({
      found: ['sandy-worker-old-running', 'sandy-worker-old-stopped'],
      deleted: ['sandy-worker-old-running', 'sandy-worker-old-stopped'],
      failed: [],
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      'container',
      ['list', '--format', 'json', '--all'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
    expect(
      mockExecFile.mock.calls
        .filter(([, args]) => Array.isArray(args) && args[0] === 'delete')
        .map(([, args]) => (args as string[]).at(-1)),
    ).toEqual(['sandy-worker-old-running', 'sandy-worker-old-stopped']);
  });
});

describe('appleContainer() — integration (real `container` CLI)', () => {
  /*
   * Opt-in: set SANDCASTLE_INTEGRATION=1 to exercise the real Apple Container
   * binary. The handoff specifies a round-trip via copyFileIn -> exec cat ->
   * copyFileOut. Kept minimal to avoid pulling in a full sandcastle harness.
   */
  // Real round-trip (copyFileIn -> exec cat -> copyFileOut) against the actual
  // `container` CLI. Kept as a todo until the end-to-end setup (issue #9) wires
  // the sandcastle image + daemon; flesh it out (gated on SANDCASTLE_INTEGRATION)
  // the first time integration mode is exercised on a real workstation.
  it.todo(
    'round-trips a binary file via copyFileIn + exec cat + copyFileOut (needs SANDCASTLE_INTEGRATION)',
  );
});
