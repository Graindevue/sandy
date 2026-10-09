import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTrustedRequest, reviewRequest } from './request.mjs';

const repo = { private: true, fork: false, default_branch: 'main', id: 12 };
const pr = { state: 'open', head: { repo: { id: 12 } }, base: { repo: { id: 12 } } };

test('accepts a standalone @sandy mention and does not evaluate comment text as code', () => {
  for (const mention of ['@sandy', 'Please @sandy check this.', '@SANDY!', '@sandy review']) {
    assert.deepEqual(
      reviewRequest('issue_comment', {
        action: 'created',
        issue: { number: 3, pull_request: {} },
        comment: { body: `${mention}\n$(echo injected)`, user: { type: 'User', login: 'tony' } },
      }),
      { prNumber: 3, actor: 'tony' },
    );
  }
});

test('rejects comments from bots, plain issues, edited comments and look-alike handles', () => {
  const event = {
    action: 'created',
    issue: { number: 3, pull_request: {} },
    comment: { body: '@sandy', user: { type: 'User', login: 'tony' } },
  };
  for (const changed of [
    { ...event, action: 'edited' },
    { ...event, issue: { number: 3 } },
    { ...event, comment: { ...event.comment, user: { type: 'Bot' } } },
    ...['@agent-sandy review', '@sandybot', '@sandy-review', '@sandy_review', 'prefix@sandy'].map(
      (body) => ({ ...event, comment: { ...event.comment, body } }),
    ),
  ]) {
    assert.throws(() => reviewRequest('issue_comment', changed));
  }
});

test('rejects every trigger other than a newly created PR comment', () => {
  const payload = {
    action: 'rerequested',
    sender: { type: 'User', login: 'tony' },
    inputs: { pr: '5' },
    check_run: { name: 'Sandy', app: { id: 3909356 }, pull_requests: [{ number: 5 }] },
  };
  for (const eventName of ['check_run', 'workflow_dispatch', 'push', 'pull_request']) {
    assert.throws(() => reviewRequest(eventName, payload));
  }
});

test('rerunning an old comment workflow requires a new @sandy comment instead', () => {
  const payload = {
    action: 'created',
    issue: { number: 3, pull_request: {} },
    comment: { body: '@sandy', user: { type: 'User', login: 'tony' } },
  };
  for (const attempt of ['2', '3', '0', 'invalid']) {
    assert.throws(() => reviewRequest('issue_comment', payload, attempt));
  }
});

test('subscription review rejects public repos, forks, closed PRs, reader actors and PR workflow refs', () => {
  assert.doesNotThrow(() => assertTrustedRequest(repo, pr, 'write', 'refs/heads/main', 'tony'));
  for (const [repository, pull, permission, ref, actor] of [
    [{ ...repo, private: false }, pr, 'write', 'refs/heads/main', 'tony'],
    [{ ...repo, fork: true }, pr, 'write', 'refs/heads/main', 'tony'],
    [repo, { ...pr, state: 'closed' }, 'write', 'refs/heads/main', 'tony'],
    [repo, { ...pr, head: { repo: { id: 99 } } }, 'write', 'refs/heads/main', 'tony'],
    [repo, pr, 'read', 'refs/heads/main', 'tony'],
    [repo, pr, 'write', 'refs/heads/feature', 'tony'],
    [repo, pr, 'write', 'refs/heads/main', ''],
  ]) {
    assert.throws(() => assertTrustedRequest(repository, pull, permission, ref, actor));
  }
});

test('comment requests reject invalid PR number values', () => {
  for (const value of ['0', '-1', '1; echo x', '1.5', 'NaN', '9007199254740992']) {
    assert.throws(() =>
      reviewRequest('issue_comment', {
        action: 'created',
        issue: { number: value, pull_request: {} },
        comment: { body: '@sandy', user: { type: 'User', login: 'tony' } },
      }),
    );
  }
});

test('an audited smoke commit cannot bypass the default-branch requirement', () => {
  const sha = 'a'.repeat(40);
  const workflow = { eventName: 'workflow_dispatch', sha, trustedSha: sha };
  assert.throws(() =>
    assertTrustedRequest(repo, pr, 'write', 'refs/heads/audited-smoke', 'tony', workflow),
  );
  for (const changed of [
    { ...workflow, trustedSha: '' },
    { ...workflow, trustedSha: 'a'.repeat(39) },
    { ...workflow, trustedSha: 'b'.repeat(40) },
    { ...workflow, sha: 'b'.repeat(40) },
    { ...workflow, eventName: 'issue_comment' },
    { ...workflow, eventName: 'check_run' },
  ]) {
    assert.throws(() =>
      assertTrustedRequest(repo, pr, 'write', 'refs/heads/audited-smoke', 'tony', changed),
    );
  }
  assert.throws(() =>
    assertTrustedRequest(repo, pr, 'read', 'refs/heads/audited-smoke', 'tony', workflow),
  );
  assert.throws(() =>
    assertTrustedRequest(
      { ...repo, private: false },
      pr,
      'write',
      'refs/heads/audited-smoke',
      'tony',
      workflow,
    ),
  );
});
