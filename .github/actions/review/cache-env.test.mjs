import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(
  new URL('../../../packages/bot-worker/package.json', import.meta.url),
);
const { parse } = require('yaml');
const action = parse(await readFile(new URL('./action.yml', import.meta.url), 'utf8'));
const ci = parse(await readFile(new URL('../../workflows/ci.yml', import.meta.url), 'utf8'));
const names = [
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_CACHE_URL',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_RUNTIME_URL',
  'ACTIONS_CACHE_SERVICE_V2',
];

function exportStep(steps) {
  const step = steps.find((entry) => entry.id === 'cache-runtime');
  assert.ok(step, 'Trusted Node action must expose runtime cache credentials to later shell steps');
  assert.equal(step.uses, 'actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
  return step;
}

test('the exact trusted cache script masks the token before exporting only cache runtime variables', async () => {
  const step = exportStep(action.runs.steps);
  const run = new (Object.getPrototypeOf(async () => {}).constructor)(
    'core',
    'process',
    step.with.script,
  );
  const env = Object.fromEntries(names.map((name) => [name, `fixture-${name}`]));
  const exports = [];
  await run(
    {
      setSecret: (value) => exports.push(['mask', value]),
      exportVariable: (name, value) => exports.push(['export', name, value]),
      info: () => assert.fail('Cache credentials must never be logged'),
    },
    {
      env: {
        ...env,
        CODEX_AUTH_JSON: 'private Codex auth',
        GITHUB_TOKEN: 'private GitHub token',
        OTHER: 'unrelated',
      },
    },
  );
  assert.deepEqual(exports, [
    ['mask', 'fixture-ACTIONS_RUNTIME_TOKEN'],
    ...names.map((name) => ['export', name, `fixture-${name}`]),
  ]);
  const position = action.runs.steps.indexOf(step);
  assert.ok(position < action.runs.steps.findIndex((entry) => entry.id === 'auth'));
  assert.ok(
    position < action.runs.steps.findIndex((entry) => entry.name === 'Review the pull request'),
  );
});

test('absent optional cache runtime variables stay absent', async () => {
  const step = exportStep(action.runs.steps);
  const run = new (Object.getPrototypeOf(async () => {}).constructor)(
    'core',
    'process',
    step.with.script,
  );
  const exports = [];
  await run(
    {
      setSecret: () => assert.fail('Missing token must not be masked'),
      exportVariable: (name, value) => exports.push([name, value]),
    },
    { env: { ACTIONS_RESULTS_URL: 'https://cache.example.test', ACTIONS_RUNTIME_TOKEN: '' } },
  );
  assert.deepEqual(exports, [['ACTIONS_RESULTS_URL', 'https://cache.example.test']]);
});

test('Linux CI exercises the shipped cache adapter after the same credential export contract', () => {
  const job = ci.jobs['dependency-cache'];
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job.environment, undefined);
  const step = exportStep(job.steps);
  assert.equal(step.with.script, exportStep(action.runs.steps).with.script);
  const probe = job.steps.find((entry) => entry.run === 'node scripts/dependency-cache-probe.mjs');
  assert.ok(probe, 'CI must perform a real provider round trip');
  assert.ok(job.steps.indexOf(step) < job.steps.indexOf(probe));
  assert.ok(job.steps.some((entry) => entry.run?.includes('--filter @sandy/bot-worker build')));
});
