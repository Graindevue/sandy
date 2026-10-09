import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scanner = join(root, '.sandy', 'tools', 'gitleaks');
const script = join(root, 'scripts', 'check-secrets.sh');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function scan(cwd, args = [], binary = scanner) {
  return spawnSync('bash', [script, ...args], {
    cwd,
    env: { ...process.env, GITLEAKS_BIN: binary },
    encoding: 'utf8',
  });
}

test('staged scanning rejects a newly added credential and redacts its value', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'sandy-secret-test-'));
  try {
    git(scratch, 'init', '-b', 'main');
    await writeFile(join(scratch, 'README.md'), 'Scanner fixture.\n');
    git(scratch, 'add', 'README.md');
    git(
      scratch,
      '-c',
      'user.name=Scanner Test',
      '-c',
      'user.email=scanner@example.invalid',
      'commit',
      '-m',
      'Initial fixture',
    );

    // Generated fake value: no credential is embedded in the test or checked in.
    const token = `ghp_${randomBytes(18).toString('hex')}`;
    await writeFile(join(scratch, 'credential.txt'), `GITHUB_TOKEN="${token}" # gitleaks:allow\n`);
    assert.equal(scan(scratch, ['--staged']).status, 0, 'Unstaged files are outside the index');
    git(scratch, 'add', 'credential.txt');
    const result = scan(scratch, ['--staged']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /leaks found/);
    assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a deleted credential remains detectable in full history', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'sandy-secret-history-test-'));
  try {
    git(scratch, 'init', '-b', 'main');
    const token = `ghp_${randomBytes(18).toString('hex')}`;
    await writeFile(join(scratch, 'credential.txt'), `GITHUB_TOKEN="${token}"\n`);
    git(scratch, 'add', 'credential.txt');
    git(
      scratch,
      '-c',
      'user.name=Scanner Test',
      '-c',
      'user.email=scanner@example.invalid',
      'commit',
      '-m',
      'Fixture with fake token',
    );
    git(scratch, 'rm', 'credential.txt');
    git(
      scratch,
      '-c',
      'user.name=Scanner Test',
      '-c',
      'user.email=scanner@example.invalid',
      'commit',
      '-m',
      'Delete fixture token',
    );
    const result = scan(scratch);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a missing scanner fails closed', () => {
  const result = scan(root, ['--staged'], join(tmpdir(), 'sandy-scanner-does-not-exist'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Gitleaks is missing/);
});
