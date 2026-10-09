import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('an immutable fingerprint excludes only its exact historical match', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'sandy-secret-fingerprint-test-'));
  try {
    git(scratch, 'init', '-b', 'main');
    const path = 'credential.txt';
    const historicalToken = `ghp_${randomBytes(18).toString('hex')}`;
    await writeFile(join(scratch, path), `API_KEY="${historicalToken}"\n`);
    git(scratch, 'add', path);
    git(
      scratch,
      '-c',
      'user.name=Scanner Test',
      '-c',
      'user.email=scanner@example.invalid',
      'commit',
      '-m',
      'Historical fixture with generated fake key',
    );

    async function scanReport() {
      const reportPath = join(scratch, 'redacted-report.json');
      const result = spawnSync(
        scanner,
        [
          'git',
          '--log-opts=--all --full-history',
          '--redact=100',
          '--ignore-gitleaks-allow',
          '--no-banner',
          '--report-format=json',
          '--report-path',
          reportPath,
          '.',
        ],
        { cwd: scratch, encoding: 'utf8' },
      );
      assert.equal(result.status, 1, result.stderr);
      const report = await readFile(reportPath, 'utf8');
      assert.equal(`${result.stdout}${result.stderr}${report}`.includes(historicalToken), false);
      return { findings: JSON.parse(report), report };
    }

    const historical = (await scanReport()).findings;
    assert.equal(historical.length, 1);
    assert.equal(historical[0].RuleID, 'github-pat');
    assert.equal(historical[0].File, path);
    assert.equal(historical[0].StartLine, 1);
    assert.equal(historical[0].Fingerprint, `${historical[0].Commit}:${path}:github-pat:1`);
    await writeFile(join(scratch, '.gitleaksignore'), `${historical[0].Fingerprint}\n`);
    assert.equal(scan(scratch).status, 0, 'Only the reviewed historical fingerprint is excluded');

    const laterToken = `ghp_${randomBytes(18).toString('hex')}`;
    await writeFile(join(scratch, path), `API_KEY="${laterToken}"\n`);
    git(scratch, 'add', path, '.gitleaksignore');
    git(
      scratch,
      '-c',
      'user.name=Scanner Test',
      '-c',
      'user.email=scanner@example.invalid',
      'commit',
      '-m',
      'Later fixture key at the same path and line',
    );

    const laterScan = scan(scratch);
    assert.equal(laterScan.status, 1, laterScan.stderr);
    assert.equal(`${laterScan.stdout}${laterScan.stderr}`.includes(laterToken), false);
    const later = await scanReport();
    assert.equal(later.report.includes(laterToken), false);
    assert.equal(later.findings.length, 1, 'The historical match stays excluded');
    assert.equal(later.findings[0].RuleID, historical[0].RuleID);
    assert.equal(later.findings[0].File, historical[0].File);
    assert.equal(later.findings[0].StartLine, historical[0].StartLine);
    assert.notEqual(later.findings[0].Commit, historical[0].Commit);
    assert.notEqual(later.findings[0].Fingerprint, historical[0].Fingerprint);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a missing scanner fails closed', () => {
  const result = scan(root, ['--staged'], join(tmpdir(), 'sandy-scanner-does-not-exist'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Gitleaks is missing/);
});
