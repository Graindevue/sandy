import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertNoPrivateKeys } from './verify-checkout.mjs';

test('checkout verification accepts ordinary temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sandy-checkout-test-'));
  try {
    await writeFile(join(directory, 'event.json'), '{"action":"created"}');
    await assert.doesNotReject(assertNoPrivateKeys(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('checkout verification rejects leftover private keys without printing their contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sandy-checkout-test-'));
  try {
    await mkdir(join(directory, 'nested'));
    for (const header of ['OPENSSH ', 'RSA ', 'EC ', '']) {
      await writeFile(
        join(directory, 'nested', 'key'),
        `-----BEGIN ${header}PRIVATE KEY-----\nTEST-SECRET`,
      );
      await assert.rejects(assertNoPrivateKeys(directory), (error) => {
        assert.match(error.message, /Checkout left a private key/);
        assert.ok(!error.message.includes('TEST-SECRET'));
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('checkout verification rejects retained SSH commands and HTTP auth headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sandy-checkout-test-'));
  const repository = join(directory, 'sandy');
  const temporary = join(directory, 'runner-temp');
  try {
    await mkdir(repository);
    await mkdir(temporary);
    execFileSync('git', ['init', '--quiet', repository]);
    for (const key of ['core.sshCommand', 'http.https://github.com/.extraheader']) {
      execFileSync('git', ['-C', repository, 'config', key, 'TEST-SECRET']);
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./verify-checkout.mjs', import.meta.url))],
        {
          env: { ...process.env, GITHUB_WORKSPACE: directory, RUNNER_TEMP: temporary },
          encoding: 'utf8',
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Checkout left git authentication configured/);
      assert.ok(!result.stderr.includes('TEST-SECRET'));
      execFileSync('git', ['-C', repository, 'config', '--unset', key]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
