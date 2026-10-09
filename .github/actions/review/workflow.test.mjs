import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(
  new URL('../../../packages/bot-worker/package.json', import.meta.url),
);
const { parse } = require('yaml');
const workflow = parse(
  await readFile(new URL('../../workflow-templates/sandy-review.yml', import.meta.url), 'utf8'),
);
const authorize = new (Object.getPrototypeOf(async () => {}).constructor)(
  'context',
  'github',
  'core',
  'process',
  workflow.jobs.review.steps[0].with.script,
);
const repository = { private: true, fork: false, id: 12, default_branch: 'main' };

function event(body = '@sandy') {
  return {
    action: 'created',
    repository,
    sender: { type: 'User', login: 'tony' },
    issue: { number: 3, pull_request: {} },
    comment: { body, user: { type: 'User', login: 'tony' } },
  };
}

async function request(payload, eventName = 'issue_comment', permission = 'write', attempt = '1') {
  const outputs = {};
  await authorize(
    { payload, eventName, repo: { owner: 'acme', repo: 'widget' } },
    {
      rest: {
        repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission } }) },
        pulls: {
          get: async () => ({
            data: { state: 'open', head: { repo: { id: 12 } }, base: { repo: { id: 12 } } },
          }),
        },
      },
    },
    {
      setOutput: (key, value) => {
        outputs[key] = value;
      },
    },
    { env: { GITHUB_RUN_ATTEMPT: attempt } },
  );
  return outputs;
}

test('the caller workflow subscribes only to new comments and keeps the auth job serialized', () => {
  assert.deepEqual(workflow.on, { issue_comment: { types: ['created'] } });
  assert.equal(workflow.concurrency, undefined);
  assert.deepEqual(workflow.jobs.review.concurrency, {
    group: 'sandy-codex-session',
    queue: 'max',
    'cancel-in-progress': false,
  });
  assert.equal(workflow.jobs.review.environment, 'sandy-codex');
});

test('the exact caller authorization script accepts @sandy and rejects old or unauthorized requests', async () => {
  for (const body of ['@sandy', 'Please @sandy check this.', '@SANDY!', '@sandy review']) {
    assert.deepEqual(await request(event(body)), { 'pr-number': '3' });
  }
  for (const body of ['@agent-sandy review', '@sandybot', '@sandy-review', 'prefix@sandy']) {
    await assert.rejects(request(event(body)));
  }
  for (const eventName of ['check_run', 'workflow_dispatch', 'push', 'pull_request']) {
    await assert.rejects(request(event(), eventName));
  }
  await assert.rejects(request({ ...event(), action: 'edited' }));
  await assert.rejects(request({ ...event(), issue: { number: 3 } }));
  await assert.rejects(
    request({
      ...event(),
      comment: { body: '@sandy', user: { type: 'Bot', login: 'bot' } },
    }),
  );
  await assert.rejects(request(event(), 'issue_comment', 'read'));
  await assert.rejects(request(event(), 'issue_comment', 'write', '2'));
});
