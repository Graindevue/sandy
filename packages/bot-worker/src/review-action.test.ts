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
  it('keeps serial execution as the rollout default and bounds explicitly enabled parallel Reviews', () => {
    expect(loadReviewActionConfig(env)).toMatchObject({
      executionMode: 'serial',
      maxAgentConcurrency: 1,
    });
    expect(
      loadReviewActionConfig({ ...env, SANDY_REVIEW_EXECUTION_MODE: 'parallel' }),
    ).toMatchObject({
      executionMode: 'parallel',
      maxAgentConcurrency: 3,
    });
    expect(
      loadReviewActionConfig({
        ...env,
        SANDY_REVIEW_EXECUTION_MODE: 'parallel',
        SANDY_REVIEW_AGENT_CONCURRENCY: '1',
      }),
    ).toMatchObject({
      executionMode: 'serial',
      maxAgentConcurrency: 1,
    });
    for (const cap of ['0', '-1', '1.5', '9007199254740992']) {
      expect(() => loadReviewActionConfig({ ...env, SANDY_REVIEW_AGENT_CONCURRENCY: cap })).toThrow(
        'SANDY_REVIEW_AGENT_CONCURRENCY',
      );
    }
    expect(() => loadReviewActionConfig({ ...env, SANDY_REVIEW_EXECUTION_MODE: 'fast' })).toThrow(
      'SANDY_REVIEW_EXECUTION_MODE',
    );
  });
  it('defaults to focused verification with a bounded optional full suite', () => {
    expect(loadReviewActionConfig(env)).toMatchObject({
      testMode: 'targeted',
      testTimeoutMs: 120_000,
    });
    expect(
      loadReviewActionConfig({
        ...env,
        SANDY_REVIEW_TEST_MODE: 'suite',
        SANDY_REVIEW_TEST_TIMEOUT_SECONDS: '60',
      }),
    ).toMatchObject({ testMode: 'suite', testTimeoutMs: 60_000 });
  });
  it('rejects unknown test modes and invalid suite budgets', () => {
    expect(() => loadReviewActionConfig({ ...env, SANDY_REVIEW_TEST_MODE: 'fast' })).toThrow(
      'SANDY_REVIEW_TEST_MODE',
    );
    for (const seconds of ['0', '-1', '1.5', '601', '9007199254740992']) {
      expect(() =>
        loadReviewActionConfig({ ...env, SANDY_REVIEW_TEST_TIMEOUT_SECONDS: seconds }),
      ).toThrow('SANDY_REVIEW_TEST_TIMEOUT_SECONDS');
    }
  });
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
  it.each(['0', '-1', '4;echo bad', '1e3', '9007199254740992'])(
    'rejects invalid PR number %s',
    (number) => {
      expect(() => loadReviewActionConfig({ ...env, SANDY_PR_NUMBER: number })).toThrow(
        'SANDY_PR_NUMBER',
      );
    },
  );
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
