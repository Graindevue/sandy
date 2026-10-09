import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authMasks, seedAuth, validateManagedAuth } from './auth.mjs';

function auth(refresh = 'test-refresh') {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { refresh_token: refresh, access_token: 'test-access', id_token: 'test-id' },
  });
}

test('seeding never overwrites an already rotated auth file with a stale secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sandy-auth-test-'));
  try {
    assert.equal(await seedAuth(directory, auth('rotated')), auth('rotated'));
    assert.equal(await seedAuth(directory, auth('stale')), auth('rotated'));
    assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), auth('rotated'));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'auth.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth requires managed ChatGPT tokens and masks each nested token', () => {
  assert.doesNotThrow(() => validateManagedAuth(auth()));
  assert.deepEqual(authMasks(auth()), [auth(), 'test-refresh', 'test-access', 'test-id']);
  for (const invalid of [
    '{}',
    '{"auth_mode":"api-key","OPENAI_API_KEY":"test"}',
    '{"auth_mode":"chatgptAuthTokens","tokens":{"refresh_token":"test"}}',
    '{"auth_mode":"chatgpt","tokens":{"access_token":"test"}}',
  ]) {
    assert.throws(() => validateManagedAuth(invalid));
  }
});
