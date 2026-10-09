import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchPostMergeChecks, mergeDependabotUpdates } from '../dependabot-auto-merge.mjs';

const context = {
  repo: { owner: 'Graindevue', repo: 'sandy' },
  payload: { repository: { default_branch: 'main' } },
};

async function attempt({
  pull = {},
  review = {},
  current = {},
  currents = [],
  trace = { gets: 0, delays: [] },
  failFirst = false,
} = {}) {
  const candidate = {
    number: 1,
    user: { login: 'dependabot[bot]' },
    draft: false,
    state: 'open',
    base: { ref: 'main' },
    head: { sha: 'reviewed', repo: { full_name: 'Graindevue/sandy' } },
    title: 'build(deps): bump yaml',
    mergeable: true,
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
        get: async ({ pull_number }) => {
          const response = currents[trace.gets] ?? current;
          trace.gets += 1;
          return { data: { ...candidate, number: pull_number, ...response } };
        },
        merge: async (variables) => {
          mutations.push({ merge: variables });
          if (failFirst && variables.pull_number === 1) throw new Error('Head moved (409)');
          return { data: { merged: true } };
        },
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
  const merged = await mergeDependabotUpdates({
    github,
    context,
    sleep: async (ms) => trace.delays.push(ms),
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
  return { mutations, warnings, failures, merged };
}

async function assertNotMerged(options) {
  assert.deepEqual(await attempt(options), {
    mutations: [],
    warnings: [],
    failures: [],
    merged: false,
  });
}

test('merges the reviewed head only when green', async () => {
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
    ],
    warnings: [],
    failures: [],
    merged: true,
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
    { mergeable: null },
    { mergeable: false },
  ])
    await assertNotMerged({ current });
});

test('a merge race is reported without preventing later PRs from merging', async () => {
  const result = await attempt({ failFirst: true });
  assert.deepEqual(
    result.mutations.filter((entry) => entry.merge).map((entry) => entry.merge.pull_number),
    [1, 2],
  );
  assert.equal(result.merged, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /#1.*409/);
  assert.equal(result.failures.length, 1);
});

test('waits briefly for mergeability without merging a head that changes during calculation', async () => {
  const trace = { gets: 0, delays: [] };
  const result = await attempt({
    trace,
    currents: [{ mergeable: null, mergeable_state: 'unknown' }, {}],
  });
  assert.equal(result.merged, true);
  assert.deepEqual(trace, { gets: 2, delays: [1000] });

  await assertNotMerged({
    currents: [
      { mergeable: null, mergeable_state: 'unknown' },
      { head: { sha: 'new', repo: { full_name: 'Graindevue/sandy' } } },
    ],
  });
  const pending = { gets: 0, delays: [] };
  await assertNotMerged({
    trace: pending,
    current: { mergeable: null, mergeable_state: 'unknown' },
  });
  assert.deepEqual(pending, { gets: 3, delays: [1000, 2000] });
});

async function dispatch({ fails = () => false } = {}) {
  const calls = [];
  const warnings = [];
  const failures = [];
  const delays = [];
  await dispatchPostMergeChecks({
    context,
    github: {
      rest: {
        actions: {
          createWorkflowDispatch: async (params) => {
            calls.push(params);
            if (fails(params.workflow_id, calls.length)) throw new Error('Service unavailable');
          },
        },
      },
    },
    sleep: async (ms) => delays.push(ms),
    core: {
      info() {},
      warning: (message) => warnings.push(message),
      setFailed: (message) => failures.push(message),
    },
  });
  return { calls, warnings, failures, delays };
}

test('post-merge checks can be recovered without an open PR or another merge', async () => {
  const result = await dispatch();
  assert.deepEqual(result.calls, [
    { ...context.repo, workflow_id: 'ci.yml', ref: 'main' },
    { ...context.repo, workflow_id: 'security.yml', ref: 'main' },
  ]);
  assert.deepEqual(result.failures, []);
});

test('transient dispatch errors are retried before the other workflow is dispatched', async () => {
  const result = await dispatch({ fails: (_, attempt) => attempt === 1 });
  assert.deepEqual(
    result.calls.map((call) => call.workflow_id),
    ['ci.yml', 'ci.yml', 'security.yml'],
  );
  assert.deepEqual(result.delays, [1000]);
  assert.deepEqual(result.failures, []);
});

test('a failed CI dispatch still launches Security and a rerun can recover both checks', async () => {
  const result = await dispatch({ fails: (workflow) => workflow === 'ci.yml' });
  assert.deepEqual(
    result.calls.map((call) => call.workflow_id),
    ['ci.yml', 'ci.yml', 'ci.yml', 'security.yml'],
  );
  assert.deepEqual(result.delays, [1000, 2000]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /ci.yml/);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /rerun/);
  assert.equal((await dispatch()).calls.length, 2);
});
