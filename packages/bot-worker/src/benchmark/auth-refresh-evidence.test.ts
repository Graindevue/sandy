import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { observeDedicatedAuthRefresh } from './auth-refresh-evidence.js';

it('captures refresh evidence without changing dedicated authentication and verifies same-account rotation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sandy-refresh-evidence-'));
  const path = join(home, 'auth.json');
  const initial = {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      id_token: 'synthetic-id',
      account_id: 'synthetic-account',
    },
    last_refresh: new Date().toISOString(),
    extra: 'preserve',
  };
  try {
    await writeFile(path, JSON.stringify(initial));
    const probe = await observeDedicatedAuthRefresh(home);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(initial);
    expect(await probe.refreshObserved()).toBe(false);
    await writeFile(path, JSON.stringify({ ...initial, last_refresh: new Date().toISOString() }));
    expect(await probe.refreshObserved()).toBe(false);
    await writeFile(
      path,
      JSON.stringify({
        ...initial,
        tokens: { ...initial.tokens, access_token: 'synthetic-rotated' },
        last_refresh: new Date().toISOString(),
      }),
    );
    expect(await probe.refreshObserved()).toBe(true);
    await writeFile(
      path,
      JSON.stringify({
        ...initial,
        tokens: { ...initial.tokens, access_token: 'synthetic-rotated', account_id: 'other' },
        last_refresh: new Date().toISOString(),
      }),
    );
    expect(await probe.refreshObserved()).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('refuses a symlinked test auth file before changing its target', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sandy-refresh-symlink-'));
  try {
    const target = join(home, 'private-auth');
    await writeFile(target, 'synthetic-sensitive-content');
    await symlink(target, join(home, 'auth.json'));
    await expect(observeDedicatedAuthRefresh(home)).rejects.toThrow('regular file');
    expect(await readFile(target, 'utf8')).toBe('synthetic-sensitive-content');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
