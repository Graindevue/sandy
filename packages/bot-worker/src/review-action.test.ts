import { describe, expect, it } from 'vitest';
import type { PullRequestFacts } from './github/types.js';
import { assertReviewablePullRequest, loadReviewActionConfig } from './review-action.js';

const env = {
  SANDY_ROOT: '/trusted/sandy',
  SANDY_REPOSITORY: 'acme/widget',
  SANDY_PR_NUMBER: '42',
  SANDY_CONFIG_PATH: '/runner/config.yaml',
  CONVEX_URL: 'https://example.convex.cloud',
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY_PATH: '/runner/private-key.pem',
  CODEX_HOME: '/runner/codex',
  SANDY_CLONE_DIR: '/runner/clones',
  RUNNER_TEMP: '/runner/temp',
};

const pr: PullRequestFacts = {
  number: 42,
  draft: false,
  headSha: 'a'.repeat(40),
  baseRef: 'main',
  title: 'Review',
  author: 'alice',
  url: 'https://github.com/acme/widget/pull/42',
  state: 'open',
  headRepo: { owner: 'acme', name: 'widget' },
};

describe('review action configuration', () => {
  it('requires an explicit dedicated Codex home and Product configuration', () => {
    expect(() => loadReviewActionConfig({ ...env, CODEX_HOME: undefined })).toThrow('CODEX_HOME');
    expect(() => loadReviewActionConfig({ ...env, SANDY_CONFIG_PATH: undefined })).toThrow(
      'SANDY_CONFIG_PATH',
    );
    expect(loadReviewActionConfig(env)).toMatchObject({
      prNumber: 42,
      codexHome: '/runner/codex',
      runnerTempDir: '/runner/temp',
      repository: { owner: 'acme', name: 'widget' },
    });
  });
  it.each([
    '0',
    '-1',
    '4;echo bad',
    '1e3',
    '9007199254740992',
  ])('rejects invalid PR number %s', (number) => {
    expect(() => loadReviewActionConfig({ ...env, SANDY_PR_NUMBER: number })).toThrow(
      'SANDY_PR_NUMBER',
    );
  });
});

describe('review action PR eligibility', () => {
  it('accepts an open same-repository PR', () => {
    expect(() => assertReviewablePullRequest({ owner: 'ACME', name: 'widget' }, pr)).not.toThrow();
  });
  it('declines missing, closed, fork, and malformed heads before launching Codex', () => {
    const repo = { owner: 'acme', name: 'widget' };
    expect(() => assertReviewablePullRequest(repo, null)).toThrow('resolved');
    expect(() => assertReviewablePullRequest(repo, { ...pr, state: 'merged' })).toThrow('open');
    expect(() => assertReviewablePullRequest(repo, { ...pr, headRepo: null })).toThrow('fork');
    expect(() =>
      assertReviewablePullRequest(repo, { ...pr, headRepo: { owner: 'fork', name: 'widget' } }),
    ).toThrow('fork');
    expect(() => assertReviewablePullRequest(repo, { ...pr, headSha: '--help' })).toThrow('SHA');
  });
});
