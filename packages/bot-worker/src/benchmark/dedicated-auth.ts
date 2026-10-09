import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ChatgptAuth {
  tokens: Record<string, unknown> & {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };
  last_refresh?: unknown;
  [key: string]: unknown;
}

/** Trusted benchmark memory only. Never logs, writes or selects an implicit login. */
export async function readDedicatedBenchmarkAuth(ciHome: string): Promise<ChatgptAuth> {
  const home = await realpath(ciHome);
  let interactiveHome = join(homedir(), '.codex');
  try {
    interactiveHome = await realpath(interactiveHome);
  } catch {
    /* A missing interactive login still has a reserved path. */
  }
  if (home === interactiveHome || home === (await realpath(homedir())))
    throw new Error('Interactive authentication cannot be used for benchmark evidence');
  const path = join(home, 'auth.json');
  if (!(await lstat(path)).isFile()) throw new Error('Dedicated test auth must be a regular file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 65_536)
      throw new Error('Unexpected dedicated test auth file');
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) throw new Error('Unexpected dedicated test auth file');
    let auth: ChatgptAuth;
    try {
      auth = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as ChatgptAuth;
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
      throw new Error('Benchmark evidence requires dedicated ChatGPT test authentication');
    return auth;
  } finally {
    await file.close();
  }
}
