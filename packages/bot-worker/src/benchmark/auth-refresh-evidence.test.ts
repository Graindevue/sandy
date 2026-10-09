import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { markDedicatedAuthForRefresh } from './auth-refresh-evidence.js';

it('forces only refresh age and reports rotated auth as a boolean after runtime shutdown', async () => {
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
    const probe = await markDedicatedAuthForRefresh(home);
    const marked = JSON.parse(await readFile(path, 'utf8'));
    expect(marked.tokens).toEqual(initial.tokens);
    expect(marked.extra).toBe('preserve');
    expect(Date.parse(marked.last_refresh)).toBeLessThan(Date.now() - 8 * 24 * 60 * 60 * 1000);
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
    await expect(markDedicatedAuthForRefresh(home)).rejects.toThrow('regular file');
    expect(await readFile(target, 'utf8')).toBe('synthetic-sensitive-content');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
