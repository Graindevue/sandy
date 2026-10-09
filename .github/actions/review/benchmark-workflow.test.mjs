import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(
  new URL('../../../packages/bot-worker/package.json', import.meta.url),
);
const { parse } = require('yaml');
const workflow = parse(
  await readFile(new URL('../../workflow-templates/sandy-benchmark.yml', import.meta.url), 'utf8'),
);
const job = workflow.jobs.benchmark;
const steps = job.steps;
const authorize = new (Object.getPrototypeOf(async () => {}).constructor)(
  'context',
  'github',
  'process',
  job.steps[0].with.script,
);

function request({
  privateRepository = true,
  permission = 'write',
  ref = 'refs/heads/main',
  attempt = 1,
} = {}) {
  return authorize(
    {
      eventName: 'workflow_dispatch',
      actor: 'tony',
      ref,
      repo: { owner: 'acme', repo: 'private' },
      payload: { repository: { private: privateRepository, fork: false, default_branch: 'main' } },
    },
    {
      rest: {
        repos: {
          get: async () => ({
            data: { private: privateRepository, fork: false, default_branch: 'main' },
          }),
          getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
        },
      },
    },
    { env: { GITHUB_RUN_ATTEMPT: String(attempt) } },
  );
}

test('dedicated benchmark auth is serialized separately and runs only by manual request', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(job.environment, 'sandy-codex-test');
  assert.deepEqual(job.concurrency, {
    group: 'sandy-codex-test-session',
    queue: 'max',
    'cancel-in-progress': false,
  });
  assert.equal(job.permissions?.['pull-requests'], undefined);
  assert.equal(workflow.permissions.contents, 'read');
});

test('the actual gate refuses public callers, read-only actors and nondefault branches', async () => {
  await request();
  await assert.rejects(request({ privateRepository: false }));
  await assert.rejects(request({ permission: 'read' }));
  await assert.rejects(request({ ref: 'refs/heads/unreviewed' }));
  await assert.rejects(request({ attempt: 2 }));
});

test('failed or timed-out benchmark retains rotated auth and excludes credentials from artifacts', () => {
  const seed = steps.find((s) => s.id === 'auth');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression.
  assert.equal(seed.env.CODEX_AUTH_JSON, '${{ secrets.CODEX_AUTH_JSON }}');
  for (const name of ['Create a fresh persistence token', 'Persist the dedicated test session']) {
    const step = steps.find((s) => s.name === name);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression.
    assert.equal(step.if, "${{ always() && steps.auth.outcome == 'success' }}");
  }
  assert.ok(
    steps.findIndex((s) => s.name === 'Persist the dedicated test session') <
      steps.findIndex((s) => s.name === 'Remove local credentials'),
  );
  const run = steps.find((s) => s.id === 'benchmark');
  assert.ok(run.run.includes('--require-auth-refresh'));
  assert.ok(run.run.includes('timeout --signal=TERM --kill-after=60s 65m'));
  assert.ok(job['timeout-minutes'] >= 75);
  const artifact = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(artifact.if, 'always()');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression.
  assert.equal(artifact.with.path, '${{ runner.temp }}/sandy-benchmark-results/');
  assert.ok(!artifact.with.path.includes('auth'));
});
