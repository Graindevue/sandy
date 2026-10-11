import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { failureComment } from './report-failure.mjs';

const require = createRequire(
  new URL('../../../packages/bot-worker/package.json', import.meta.url),
);
const { parse } = require('yaml');
const action = parse(await readFile(new URL('./action.yml', import.meta.url), 'utf8'));
const steps = action.runs.steps;
const runUrl = 'https://github.com/acme/widget/actions/runs/77';

test('the failure comment names the first failed step and links the run log', () => {
  const body = failureComment({
    steps: [
      ['Install and build Sandy', 'success'],
      ['Warm up Codex and allow its built-in session refresh', 'failure'],
      ['Review the pull request', 'skipped'],
    ],
    runUrl,
  });
  assert.match(body, /Sandy could not finish this review/);
  assert.match(body, /"Warm up Codex and allow its built-in session refresh" failed/);
  assert.match(body, /No findings were posted for this request/);
  assert.ok(body.includes(`[run log](${runUrl})`));
  assert.match(body, /Post a new `@sandy` comment/);
});

test('the failure comment still answers when no step reports a failure', () => {
  const body = failureComment({ steps: [['Review the pull request', 'cancelled']], runUrl });
  assert.match(body, /A setup step failed/);
  assert.ok(body.includes(`[run log](${runUrl})`));
});

test('a failed run reports on the PR unless the request was already answered', () => {
  const tokenIndex = steps.findIndex((step) => step.id === 'report-token');
  const report = steps.find((step) => step.id === 'report-failure');
  assert.ok(tokenIndex > steps.findIndex((step) => step.id === 'review'));
  const token = steps[tokenIndex];
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal test data.
  assert.equal(token.if, "${{ failure() && steps.review.outputs.request-answered != 'true' }}");
  assert.equal(token.with['permission-pull-requests'], 'write');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal test data.
  assert.equal(report.if, "${{ failure() && steps.report-token.outcome == 'success' }}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is literal test data.
  assert.equal(report.env.GH_TOKEN, '${{ steps.report-token.outputs.token }}');
  assert.equal(report.run, 'node "$GITHUB_ACTION_PATH/report-failure.mjs"');
});

test('the failure report sees the outcome of every step before it', () => {
  const report = steps.find((step) => step.id === 'report-failure');
  const reported = [
    ...report.env.SANDY_STEP_OUTCOMES.matchAll(
      /\["([^"]+)", "\$\{\{ steps\.([\w-]+)\.outcome \}\}"\]/g,
    ),
  ].map(([, name, id]) => ({ name, id }));
  const earlier = steps
    .slice(
      0,
      steps.findIndex((step) => step.id === 'report-token'),
    )
    .map((step) => ({ name: step.name, id: step.id }));
  assert.deepEqual(reported, earlier);
});

test('the warm-up step keeps its output in the log', () => {
  const warmUp = steps.find((step) => step.id === 'warm-up');
  assert.ok(warmUp, 'the warm-up step needs an id so a failure can name it');
  assert.ok(!warmUp.run.includes('/dev/null'));
});
