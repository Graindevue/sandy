import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface ChatgptAuth {
  tokens: Record<string, unknown> & {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };
  last_refresh?: unknown;
  [key: string]: unknown;
}

async function readAuth(path: string): Promise<ChatgptAuth> {
  if (!(await lstat(path)).isFile()) throw new Error('Dedicated test auth must be a regular file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 65_536)
      throw new Error('Unexpected dedicated test auth file');
    let auth: ChatgptAuth;
    try {
      auth = JSON.parse(await file.readFile('utf8')) as ChatgptAuth;
    } catch {
      throw new Error('Dedicated test auth is not valid JSON');
    }
    if (
      !auth ||
      typeof auth !== 'object' ||
      auth.OPENAI_API_KEY ||
      !auth.tokens ||
      (auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') ||
      ['access_token', 'refresh_token', 'id_token'].some(
        (key) => typeof auth.tokens[key] !== 'string' || auth.tokens[key] === '',
      )
    )
      throw new Error('Refresh evidence requires dedicated ChatGPT test authentication');
    return auth;
  } finally {
    await file.close();
  }
}

/** Only call with an explicit test login, before any Review runtime starts. Never logs auth. */
export async function markDedicatedAuthForRefresh(
  ciHome: string,
): Promise<{ refreshObserved(): Promise<boolean> }> {
  const home = await realpath(ciHome);
  let interactiveHome = join(homedir(), '.codex');
  try {
    interactiveHome = await realpath(interactiveHome);
  } catch {
    /* A missing interactive login still has a reserved path. */
  }
  if (home === interactiveHome || home === (await realpath(homedir())))
    throw new Error('Interactive authentication cannot be used for a benchmark refresh probe');
  const path = join(home, 'auth.json');
  const initial = await readAuth(path);
  const startedAt = Date.now();
  const temporary = join(home, `.benchmark-refresh-${randomUUID()}`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ ...initial, last_refresh: '2000-01-01T00:00:00Z' }),
      { mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    async refreshObserved() {
      const current = await readAuth(path);
      return (
        typeof current.last_refresh === 'string' &&
        Date.parse(current.last_refresh) >= startedAt - 30_000 &&
        ['access_token', 'refresh_token', 'id_token'].some(
          (key) => current.tokens[key] !== initial.tokens[key],
        ) &&
        current.tokens.account_id === initial.tokens.account_id
      );
    },
  };
}
