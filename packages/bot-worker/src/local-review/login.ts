import { spawn } from 'node:child_process';
import { LocalReviewInputError } from './errors.js';
import {
  acquireReviewLock,
  assertDedicatedHome,
  ensureHomeDirectories,
  isErrno,
  type LocalReviewHome,
} from './home.js';

export type LoginCommand = 'login' | 'status' | 'logout';

/** `codex login` options that choose how to sign in; the rest of its surface stays hidden. */
export const LOGIN_METHODS = ['device-auth', 'with-api-key', 'with-access-token'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export interface CodexLoginInput {
  home: LocalReviewHome;
  command: LoginCommand;
  /** How `login` signs in; Codex's browser sign-in by default. */
  method?: LoginMethod;
  env: NodeJS.ProcessEnv;
}

/**
 * Sign the dedicated Codex home in or out. Codex reads and writes the
 * credential file itself; Sandy never reads, copies, or prints it, and never
 * touches `~/.codex` or a CI login.
 */
export async function runCodexLogin(input: CodexLoginInput): Promise<number> {
  if (input.command !== 'login' && input.method !== undefined) {
    throw new LocalReviewInputError(`sandy ${commandName(input.command)} takes no sign-in method`);
  }
  await assertDedicatedHome(input.home);
  await ensureHomeDirectories(input.home);
  const args = [
    // Reviews read the file login; a keyring login would be invisible to them.
    '-c',
    'cli_auth_credentials_store="file"',
    ...(input.command === 'logout' ? ['logout'] : ['login']),
    ...(input.command === 'status' ? ['status'] : []),
    ...(input.method === undefined ? [] : [`--${input.method}`]),
  ];
  // A Review may be refreshing this login; status only reads it.
  const release = input.command === 'status' ? null : await acquireReviewLock(input.home.lock);
  try {
    return await runCodex(input.env.SANDY_CODEX_EXECUTABLE?.trim() || 'codex', args, {
      ...input.env,
      CODEX_HOME: input.home.codexHome,
    });
  } finally {
    await release?.();
  }
}

function commandName(command: LoginCommand): string {
  return command === 'status' ? 'login status' : command;
}

async function runCodex(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { env, stdio: 'inherit' });
    child.once('error', (error) => {
      reject(
        isErrno(error, 'ENOENT')
          ? new LocalReviewInputError(
              `${executable} was not found; install the Codex CLI or set SANDY_CODEX_EXECUTABLE`,
            )
          : new Error(`Could not run ${executable}: ${error.message}`, { cause: error }),
      );
    });
    child.once('close', (code, signal) => {
      resolve(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  });
}
