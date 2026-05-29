/**
 * Apple Container SandboxProvider — wraps the macOS `container` CLI.
 *
 * Originally developed for graindevue's sandcastle integration; copied into
 * Sandy and MIT-relicensed per ADR 0009, intended to be upstreamed to
 * `@ai-hero/sandcastle` over time. Relative import extensions were changed from
 * `.ts` to `.js` to match Sandy's NodeNext build; the logic is unchanged.
 */

import { execFile, execFileSync, type StdioOptions, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, renameSync, rmSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { createInterface } from 'node:readline';
import type { MountConfig } from '@ai-hero/sandcastle';
import {
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  createBindMountSandboxProvider,
  type ExecResult,
  type InteractiveExecOptions,
  type SandboxProvider,
} from '@ai-hero/sandcastle';
import { defaultImageName } from '@ai-hero/sandcastle/sandboxes/docker';

import { formatVolumeMount, processFileMountParents, resolveUserMounts } from './mount-utils.js';

export interface AppleContainerOptions {
  readonly imageName?: string;
  readonly containerNamePrefix?: string;
  readonly containerUid?: number;
  readonly containerGid?: number;
  /** VM memory for each sandbox (Apple default is 1g — too small for turbo type-check). */
  readonly memory?: string;
  /** VM CPU count for each sandbox (Apple default is 4). */
  readonly cpus?: number;
  readonly mounts?: readonly MountConfig[];
  readonly env?: Record<string, string>;
}

const BUILD_IMAGE_HINT = 'pnpm sandcastle:build-image';

/** Apple Container VMs have no DNS unless explicitly configured (build and runtime). */
const CONTAINER_DNS_ARGS = ['--dns', '1.1.1.1', '--dns', '8.8.8.8'];

/**
 * Apple `container run` defaults to 1g RAM per lightweight VM. Docker Desktop
 * shared a much larger VM, so monorepo type-check/test appeared to work there
 * without explicit limits. Sandcastle agents need headroom for turbo + tsc.
 */
const DEFAULT_CONTAINER_MEMORY = '8g';
const DEFAULT_CONTAINER_CPUS = 4;
const DEFAULT_CONTAINER_NAME_PREFIX = 'sandcastle-';

/** Bound control-plane `container` CLI calls so a wedged daemon can't hang the worker. */
const CONTAINER_CLI_TIMEOUT_MS = 60_000;

const execFileAsync = (
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: CONTAINER_CLI_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({
            stdout: (stdout ?? '').toString(),
            stderr: (stderr ?? '').toString(),
          });
        }
      },
    );
  });

const ensureContainerSystemRunning = async (): Promise<void> => {
  try {
    await execFileAsync('container', ['system', 'status']);
  } catch {
    try {
      await execFileAsync('container', ['system', 'start']);
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : String(startError);
      throw new Error(
        `Apple Container system is not running and 'container system start' failed: ${message}`,
      );
    }
  }
};

const parseImageUser = (stdout: string): string => {
  const data = JSON.parse(stdout) as unknown;
  const item = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!item) return '';

  const dockerStyle =
    (item.Config as { User?: string } | undefined)?.User ??
    (item.config as { User?: string; user?: string } | undefined)?.User ??
    (item.config as { user?: string } | undefined)?.user;
  if (dockerStyle) return String(dockerStyle);

  const variants = item.variants as
    | Array<{ config?: { config?: { User?: string }; User?: string } }>
    | undefined;
  const oci = variants?.[0]?.config;
  const ociUser = oci?.config?.User ?? oci?.User;
  return ociUser ? String(ociUser) : '';
};

const checkImageUid = async (imageName: string, expectedUid: number): Promise<void> => {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('container', ['image', 'inspect', imageName]));
  } catch {
    throw new Error(
      `Image '${imageName}' not found locally. Build it first with '${BUILD_IMAGE_HINT}'.`,
    );
  }

  let imageUser: string;
  try {
    imageUser = parseImageUser(stdout).trim();
  } catch {
    const snippet = stdout.length > 200 ? `${stdout.slice(0, 200)}…` : stdout;
    throw new Error(
      `Could not parse 'container image inspect ${imageName}' output ` +
        `(rebuild the image with '${BUILD_IMAGE_HINT}'): ${snippet}`,
    );
  }
  if (!imageUser) {
    throw new Error(
      `Image '${imageName}' has no USER directive — refusing to run as root. ` +
        `Add 'USER ${expectedUid}' to the Dockerfile and rebuild with '${BUILD_IMAGE_HINT}'.`,
    );
  }

  const uidPart = imageUser.split(':')[0] ?? '';
  const imageUid = Number.parseInt(uidPart, 10);
  if (Number.isNaN(imageUid)) {
    throw new Error(
      `Cannot verify UID for image '${imageName}': USER is declared as '${imageUser}', not a numeric UID. ` +
        `Set 'USER ${expectedUid}' (numeric) in the Dockerfile and rebuild with '${BUILD_IMAGE_HINT}'.`,
    );
  }

  if (imageUid !== expectedUid) {
    throw new Error(
      `UID mismatch: image '${imageName}' was built with UID ${imageUid}, ` +
        `but the expected UID is ${expectedUid}. ` +
        `Rebuild the image with '${BUILD_IMAGE_HINT}', ` +
        `or pass containerUid: ${imageUid} to appleContainer() to match the image.`,
    );
  }
};

type VolumeMount = {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
};

/**
 * Skip worktree `.git` file mounts at absolute macOS paths — they empty
 * `/home/agent/workspace` on Apple containers.
 *
 * Note (F4): sandcastle's SandboxFactory emits *two* `.git`-adjacent mounts —
 * the worktree's own `.git` (which we strip here) and the parent repo's
 * `.git` directory. The parent mount is intentionally preserved even though
 * it uses the absolute macOS host path: the worktree's `.git` file is a
 * `gitdir:` pointer to that absolute path, so leaving the parent mount in
 * place is what makes the pointer resolve inside the VM. Don't try to
 * "fix" the residual macOS path — sandcastle's `patchGitMountsForWindows`
 * only intervenes on `win32`, by design.
 */
const filterAppleGitFileMount = (
  mounts: readonly VolumeMount[],
  worktreeHostPath: string,
): VolumeMount[] => {
  const worktreeGit = `${worktreeHostPath.replace(/\/$/, '')}/.git`;
  return mounts.filter(
    (m) =>
      !(m.hostPath === m.sandboxPath && m.hostPath === worktreeGit && m.hostPath.startsWith('/')),
  );
};

/**
 * Stream a host file into the sandbox via `container exec -i ... 'cat > path'`.
 * Apple's `container` CLI does not ship a `cp` subcommand yet (added on `main`
 * but unreleased as of v0.12.3 — `container cp` returns `Plugin 'container-cp'
 * not found.`). Stream piping preserves binary content; the shell heredoc
 * pattern keeps the sandbox path argv-quoted so paths with spaces survive.
 */
const streamCopyFileIn = (
  containerName: string,
  hostPath: string,
  sandboxPath: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn(
      'container',
      ['exec', '-i', containerName, 'sh', '-c', 'cat > "$1"', 'sh', sandboxPath],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      reject(err);
    };

    const input = createReadStream(hostPath);
    input.on('error', (err) =>
      fail(new Error(`copyFileIn read of '${hostPath}' failed: ${err.message}`)),
    );

    proc.on('error', (err) => fail(new Error(`copyFileIn exec failed: ${err.message}`)));

    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      const exitDesc = signal ? `signal ${signal}` : `exit ${code ?? 'null'}`;
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      reject(
        new Error(
          `copyFileIn into '${sandboxPath}' failed (${exitDesc})${stderr ? `: ${stderr}` : ''}`,
        ),
      );
    });

    if (!proc.stdin) {
      fail(new Error('copyFileIn: container exec stdin not available'));
      return;
    }
    input.pipe(proc.stdin);
  });

/**
 * Stream a sandbox file out to the host via `container exec ... 'cat path'`.
 * See {@link streamCopyFileIn} for context.
 */
const streamCopyFileOut = (
  containerName: string,
  sandboxPath: string,
  hostPath: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn(
      'container',
      ['exec', containerName, 'sh', '-c', 'cat -- "$1"', 'sh', sandboxPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // Stream into a sibling temp file and only rename it into place on a clean
    // exit, so a failed or interrupted copy never truncates or partially
    // overwrites an existing host file.
    const tmpPath = `${hostPath}.${randomUUID()}.tmp`;
    const output = createWriteStream(tmpPath);

    let outputFinished = false;
    let exitInfo: {
      code: number | null;
      signal: NodeJS.Signals | null;
    } | null = null;
    let settled = false;

    const cleanupTmp = () => {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        /* best-effort */
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      output.destroy();
      cleanupTmp();
      reject(err);
    };

    const tryResolve = () => {
      if (settled || !exitInfo || !outputFinished) return;
      if (exitInfo.code === 0 && exitInfo.signal === null) {
        settled = true;
        try {
          renameSync(tmpPath, hostPath);
        } catch (err) {
          cleanupTmp();
          reject(
            new Error(
              `copyFileOut: failed to move temp file into '${hostPath}': ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
          return;
        }
        resolve();
        return;
      }
      const exitDesc = exitInfo.signal
        ? `signal ${exitInfo.signal}`
        : `exit ${exitInfo.code ?? 'null'}`;
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      fail(
        new Error(
          `copyFileOut of '${sandboxPath}' failed (${exitDesc})${stderr ? `: ${stderr}` : ''}`,
        ),
      );
    };

    output.on('finish', () => {
      outputFinished = true;
      tryResolve();
    });
    output.on('error', (err) =>
      fail(new Error(`copyFileOut write to '${hostPath}' failed: ${err.message}`)),
    );

    proc.on('error', (err) => fail(new Error(`copyFileOut exec failed: ${err.message}`)));
    proc.on('close', (code, signal) => {
      exitInfo = { code, signal };
      tryResolve();
    });

    if (!proc.stdout) {
      fail(new Error('copyFileOut: container exec stdout not available'));
      return;
    }
    proc.stdout.pipe(output);
  });

const startDetachedContainer = (
  containerName: string,
  imageName: string,
  args: string[],
): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      'container',
      ['run', '-d', '--name', containerName, ...args, imageName, 'infinity'],
      { timeout: CONTAINER_CLI_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error) => {
        if (error) {
          reject(new Error(`container run failed: ${error.message}`));
        } else {
          resolve();
        }
      },
    );
  });

/**
 * Module-level signal handling for sandbox containers.
 *
 * One handler covers every sandbox. The previous design registered a fresh
 * SIGINT/SIGTERM handler per `create()`, which meant: (1) each handler ran
 * `execFileSync` and blocked the loop, (2) the first handler's `process.exit`
 * aborted the process before the others ran, so containers leaked. The set
 * below holds container names; signal handlers iterate it and trigger
 * `container delete` for every entry in parallel with a per-container timeout.
 */
const activeContainerNames = new Set<string>();
let signalHandlersInstalled = false;
/** ~5s ceiling per container so a wedged daemon can't pin process exit. */
const CONTAINER_CLEANUP_TIMEOUT_MS = 5000;

const deleteContainerSync = (name: string): void => {
  try {
    execFileSync('container', ['delete', '-f', name], {
      stdio: 'ignore',
      // Bound the synchronous exit-path cleanup too — a wedged daemon must not
      // hang `process.exit` (the async path already uses this timeout).
      timeout: CONTAINER_CLEANUP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch {
    /* best-effort */
  }
};

const deleteContainerAsync = (name: string, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const child = execFile('container', ['delete', '-f', name], () => settle());
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      settle();
    }, timeoutMs);
  });

export interface CleanupOrphanedAppleContainersOptions {
  readonly namePrefix?: string;
}

export interface CleanupOrphanedAppleContainersResult {
  readonly found: string[];
  readonly deleted: string[];
  readonly failed: readonly { name: string; error: string }[];
}

/**
 * Reconcile containers left behind by an uncatchable worker crash, such as
 * SIGKILL from `kill -9`. Call this once during worker startup before new jobs
 * are claimed; graceful process exits are handled by the signal handlers below.
 */
export async function cleanupOrphanedAppleContainers(
  options: CleanupOrphanedAppleContainersOptions = {},
): Promise<CleanupOrphanedAppleContainersResult> {
  const namePrefix = options.namePrefix ?? DEFAULT_CONTAINER_NAME_PREFIX;
  await ensureContainerSystemRunning();

  const { stdout } = await execFileAsync('container', ['list', '--format', 'json', '--all']);
  const found = parseContainerListNames(stdout).filter((name) => name.startsWith(namePrefix));
  const settled = await Promise.all(
    found.map(async (name) => {
      try {
        await execFileAsync('container', ['delete', '-f', name]);
        return { name };
      } catch (error) {
        return {
          name,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return {
    found,
    deleted: settled.filter((item) => !('error' in item)).map((item) => item.name),
    failed: settled.filter((item): item is { name: string; error: string } => 'error' in item),
  };
}

function parseContainerListNames(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    const name = containerListItemName(item);
    return name === null ? [] : [name];
  });
}

function containerListItemName(item: unknown): string | null {
  if (!isRecord(item)) {
    return null;
  }

  for (const key of ['id', 'ID', 'name', 'Name']) {
    const value = item[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  const configuration = item.configuration;
  if (!isRecord(configuration)) {
    return null;
  }
  for (const key of ['id', 'ID', 'name', 'Name', 'hostname']) {
    const value = configuration[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const handleProcessExit = (): void => {
  for (const name of activeContainerNames) {
    deleteContainerSync(name);
  }
  activeContainerNames.clear();
};

/**
 * POSIX shell exit-code convention: a process killed by signal N reports
 * `128 + N`. We use it for the parent process on signal cleanup and to
 * surface OOM-killed child execs (where Node sets `code = null, signal =
 * 'SIGKILL'`) as a non-zero `exitCode` instead of masking them as 0.
 */
const signalToExitCode = (signal: NodeJS.Signals): number => {
  const num = (osConstants.signals as Record<string, number>)[signal] ?? 1;
  return 128 + num;
};

/** Resolve a (code, signal) tuple from `'close'` into a non-zero-on-kill exit code. */
const resolveChildExitCode = (code: number | null, signal: NodeJS.Signals | null): number => {
  if (code !== null) return code;
  if (signal) return signalToExitCode(signal);
  return 0;
};

/** Annotate stderr with the killing signal so callers see *why* exit was non-zero. */
const annotateStderrWithSignal = (stderr: string, signal: NodeJS.Signals | null): string => {
  if (!signal) return stderr;
  const note = `[apple-container] process terminated by ${signal}`;
  return stderr ? `${stderr}\n${note}` : note;
};

const handleProcessSignal = (signal: NodeJS.Signals): void => {
  const names = [...activeContainerNames];
  activeContainerNames.clear();
  const exitCode = signalToExitCode(signal);
  void Promise.allSettled(
    names.map((n) => deleteContainerAsync(n, CONTAINER_CLEANUP_TIMEOUT_MS)),
  ).then(() => {
    process.exit(exitCode);
  });
};

const ensureSignalHandlersInstalled = (): void => {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on('exit', handleProcessExit);
  process.on('SIGINT', handleProcessSignal);
  process.on('SIGTERM', handleProcessSignal);
};

export const appleContainer = (options?: AppleContainerOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const configuredContainerNamePrefix =
    options?.containerNamePrefix ?? DEFAULT_CONTAINER_NAME_PREFIX;
  const sandboxHomedir = '/home/agent';
  const userMounts = options?.mounts ? resolveUserMounts(options.mounts, sandboxHomedir) : [];
  const parentDirsToCreate = processFileMountParents(userMounts, sandboxHomedir);

  return createBindMountSandboxProvider({
    name: 'apple-container',
    // Only set `env` when provided — `exactOptionalPropertyTypes` rejects an
    // explicit `undefined` for the provider's optional `env`.
    ...(options?.env ? { env: options.env } : {}),
    sandboxHomedir,
    create: async (createOptions: BindMountCreateOptions): Promise<BindMountSandboxHandle> => {
      const containerName = `${configuredContainerNamePrefix}${randomUUID()}`;

      const worktreeMount = createOptions.mounts.find(
        (m) => m.hostPath === createOptions.worktreePath,
      );
      if (!worktreeMount) {
        throw new Error(
          `Could not locate sandbox path for worktree '${createOptions.worktreePath}' ` +
            `in mounts: ${JSON.stringify(createOptions.mounts.map((m) => m.hostPath))}`,
        );
      }
      const worktreePath = worktreeMount.sandboxPath;

      await ensureContainerSystemRunning();

      const imageName = configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      const containerUid = options?.containerUid ?? process.getuid?.() ?? 1000;
      const containerGid = options?.containerGid ?? process.getgid?.() ?? 1000;

      await checkImageUid(imageName, containerUid);

      const allMounts = filterAppleGitFileMount(
        [...createOptions.mounts, ...userMounts],
        createOptions.worktreePath,
      );
      const volumeArgs = allMounts.flatMap((m) => ['-v', formatVolumeMount(m)]);
      const env = { ...createOptions.env, HOME: '/home/agent' };
      const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);

      const containerMemory = options?.memory ?? DEFAULT_CONTAINER_MEMORY;
      const containerCpus = options?.cpus ?? DEFAULT_CONTAINER_CPUS;

      await startDetachedContainer(containerName, imageName, [
        ...CONTAINER_DNS_ARGS,
        '--memory',
        containerMemory,
        '--cpus',
        String(containerCpus),
        '--user',
        `${containerUid}:${containerGid}`,
        ...envArgs,
        ...volumeArgs,
        '-w',
        worktreePath,
        '--entrypoint',
        'sleep',
      ]);

      ensureSignalHandlersInstalled();
      activeContainerNames.add(containerName);

      try {
        for (const dir of parentDirsToCreate) {
          await new Promise<void>((resolve, reject) => {
            execFile(
              'container',
              [
                'exec',
                '--user',
                '0:0',
                containerName,
                'sh',
                '-c',
                'mkdir -p "$1" && chown "$2" "$1"',
                'sh',
                dir,
                `${containerUid}:${containerGid}`,
              ],
              { timeout: CONTAINER_CLI_TIMEOUT_MS, killSignal: 'SIGKILL' },
              (error) => {
                if (error) {
                  reject(
                    new Error(
                      `Failed to create parent directory '${dir}' in container: ${error.message}`,
                    ),
                  );
                } else {
                  resolve();
                }
              },
            );
          });
        }
      } catch (setupError) {
        activeContainerNames.delete(containerName);
        deleteContainerSync(containerName);
        throw setupError;
      }

      const handle: BindMountSandboxHandle = {
        worktreePath,

        exec: (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          const args = ['exec'];
          if (opts?.stdin !== undefined) args.push('-i');
          if (opts?.cwd) args.push('-w', opts.cwd);
          if (opts?.sudo) args.push('--user', '0:0');
          args.push(containerName, 'sh', '-c', command);

          return new Promise((resolve, reject) => {
            const proc = spawn('container', args, {
              stdio: [opts?.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });

            if (opts?.stdin !== undefined && proc.stdin) {
              proc.stdin.write(opts.stdin);
              proc.stdin.end();
            }

            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];

            if (opts?.onLine && proc.stdout) {
              const onLine = opts.onLine;
              const rl = createInterface({ input: proc.stdout });
              rl.on('line', (line) => {
                stdoutChunks.push(line);
                onLine(line);
              });
            } else if (proc.stdout) {
              proc.stdout.on('data', (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
              });
            }

            proc.stderr?.on('data', (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });

            proc.on('error', (error) => {
              reject(new Error(`container exec failed: ${error.message}`));
            });

            proc.on('close', (code, signal) => {
              resolve({
                stdout: stdoutChunks.join(opts?.onLine ? '\n' : ''),
                stderr: annotateStderrWithSignal(stderrChunks.join(''), signal),
                exitCode: resolveChildExitCode(code, signal),
              });
            });
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> =>
          new Promise((resolve, reject) => {
            const containerArgs = ['exec'];
            if ('isTTY' in opts.stdin && (opts.stdin as { isTTY?: boolean }).isTTY) {
              containerArgs.push('-it');
            } else {
              containerArgs.push('-i');
            }
            if (opts.cwd) containerArgs.push('-w', opts.cwd);
            containerArgs.push(containerName, ...args);

            const proc = spawn('container', containerArgs, {
              // sandcastle types stdin/stdout/stderr as NodeJS.Readable/Writable;
              // @types/node 24's StdioOptions no longer structurally overlaps
              // them, hence the cast. spawn ultimately needs fd-backed streams,
              // which sandcastle's interactive path supplies.
              // TODO(#9): assert the streams are fd-backed once the e2e harness
              // exercises a real interactive session.
              stdio: [opts.stdin, opts.stdout, opts.stderr] as unknown as StdioOptions,
            });

            proc.on('error', (error: Error) => {
              reject(new Error(`container exec failed: ${error.message}`));
            });

            proc.on('close', (code, signal) => {
              resolve({ exitCode: resolveChildExitCode(code, signal) });
            });
          }),

        copyFileIn: (hostPath: string, sandboxPath: string): Promise<void> =>
          streamCopyFileIn(containerName, hostPath, sandboxPath),

        copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> =>
          streamCopyFileOut(containerName, sandboxPath, hostPath),

        close: async (): Promise<void> => {
          activeContainerNames.delete(containerName);
          await new Promise<void>((resolve) => {
            execFile(
              'container',
              ['delete', '-f', containerName],
              { timeout: CONTAINER_CLI_TIMEOUT_MS, killSignal: 'SIGKILL' },
              () => resolve(),
            );
          });
        },
      };

      return handle;
    },
  });
};
