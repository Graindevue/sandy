import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeDependabotUpdates } from '../dependabot-auto-merge.mjs';

const context = {
  repo: { owner: 'Graindevue', repo: 'sandy' },
  payload: { repository: { default_branch: 'main' } },
};

async function attempt({ pull = {}, review = {}, current = {}, failFirst = false } = {}) {
  const candidate = {
    number: 1,
    user: { login: 'dependabot[bot]' },
    draft: false,
    state: 'open',
    base: { ref: 'main' },
    head: { sha: 'reviewed', repo: { full_name: 'Graindevue/sandy' } },
    title: 'build(deps): bump yaml',
    mergeable_state: 'clean',
    ...pull,
  };
  const mutations = [];
  const warnings = [];
  const failures = [];
  const github = {
    rest: {
      pulls: {
        list: 'pulls',
        listReviews: 'reviews',
        get: async ({ pull_number }) => ({
          data: { ...candidate, number: pull_number, ...current },
        }),
        merge: async (variables) => {
          mutations.push({ merge: variables });
          if (failFirst && variables.pull_number === 1) throw new Error('Head moved (409)');
          return { data: { merged: true } };
        },
      },
      actions: {
        createWorkflowDispatch: async (variables) => mutations.push({ dispatch: variables }),
      },
    },
    paginate: async (method) =>
      method === 'pulls'
        ? failFirst
          ? [candidate, { ...candidate, number: 2 }]
          : [candidate]
        : [
            {
              user: { login: 'coderabbitai[bot]' },
              state: 'APPROVED',
              commit_id: 'reviewed',
              ...review,
            },
          ],
  };
  await mergeDependabotUpdates({
    github,
    context,
    core: {
      info() {},
      warning(message) {
        warnings.push(message);
      },
      setFailed(message) {
        failures.push(message);
      },
    },
  });
  return { mutations, warnings, failures };
}

async function assertNotMerged(options) {
  assert.deepEqual(await attempt(options), { mutations: [], warnings: [], failures: [] });
}

test('merges the reviewed head only when green and dispatches post-merge checks', async () => {
  assert.deepEqual(await attempt(), {
    mutations: [
      {
        merge: {
          owner: 'Graindevue',
          repo: 'sandy',
          pull_number: 1,
          sha: 'reviewed',
          merge_method: 'squash',
          commit_title: 'fix: bump yaml',
          commit_message: '',
        },
      },
      { dispatch: { owner: 'Graindevue', repo: 'sandy', workflow_id: 'ci.yml', ref: 'main' } },
      {
        dispatch: { owner: 'Graindevue', repo: 'sandy', workflow_id: 'security.yml', ref: 'main' },
      },
    ],
    warnings: [],
    failures: [],
  });
});

test('rejects skipped, blocking, stale and non-CodeRabbit reviews', async () => {
  for (const review of [
    { state: 'COMMENTED' },
    { state: 'CHANGES_REQUESTED' },
    { state: 'DISMISSED' },
    { commit_id: 'old' },
    { user: { login: 'maintainer' } },
  ])
    await assertNotMerged({ review });
});

test('restricts write access to ready same-repository Dependabot PRs on main', async () => {
  for (const pull of [
    { user: { login: 'maintainer' } },
    { draft: true },
    { base: { ref: 'staging' } },
    { head: { sha: 'reviewed', repo: { full_name: 'attacker/sandy' } } },
  ])
    await assertNotMerged({ pull });
});

test('rejects pushes, retargets, closures and pending checks after fetching reviews', async () => {
  for (const current of [
    { head: { sha: 'new', repo: { full_name: 'Graindevue/sandy' } } },
    { state: 'closed' },
    { draft: true },
    { base: { ref: 'staging' } },
    { mergeable_state: 'blocked' },
    { mergeable_state: 'behind' },
    { mergeable_state: 'unknown' },
  ])
    await assertNotMerged({ current });
});

test('a merge race is reported without preventing later PRs from merging', async () => {
  const result = await attempt({ failFirst: true });
  assert.deepEqual(
    result.mutations.filter((entry) => entry.merge).map((entry) => entry.merge.pull_number),
    [1, 2],
  );
  assert.equal(result.mutations.filter((entry) => entry.dispatch).length, 2);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /#1.*409/);
  assert.equal(result.failures.length, 1);
});
