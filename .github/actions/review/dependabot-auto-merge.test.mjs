import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enableDependabotAutoMerge } from '../dependabot-auto-merge.mjs';

async function attempt({ pull = {}, review = {}, current = {} } = {}) {
  const candidate = {
    number: 1,
    user: { login: 'dependabot[bot]' },
    draft: false,
    state: 'open',
    base: { ref: 'main' },
    head: { sha: 'reviewed', repo: { full_name: 'Graindevue/sandy' } },
    title: 'build(deps): bump yaml',
    node_id: 'pr-1',
    ...pull,
  };
  const mutations = [];
  const github = {
    rest: {
      pulls: {
        list: 'pulls',
        listReviews: 'reviews',
        get: async () => ({ data: { ...candidate, ...current } }),
        merge: async (variables) => {
          mutations.push({ merge: variables });
          return { data: { merged: true } };
        },
      },
    },
    paginate: async (method) =>
      method === 'pulls'
        ? [candidate]
        : [
            {
              user: { login: 'coderabbitai[bot]' },
              state: 'APPROVED',
              commit_id: 'reviewed',
              ...review,
            },
          ],
    graphql: async (query, variables) => mutations.push({ query, variables }),
  };
  await enableDependabotAutoMerge({
    github,
    context: {
      repo: { owner: 'Graindevue', repo: 'sandy' },
      payload: { repository: { default_branch: 'main' } },
    },
    core: { info() {} },
  });
  return mutations;
}

test('queues an approved Dependabot PR without approving or bypassing branch rules', async () => {
  const mutations = await attempt();
  assert.equal(mutations.length, 1);
  assert.match(mutations[0].query, /enablePullRequestAutoMerge/);
  assert.deepEqual(mutations[0].variables, {
    id: 'pr-1',
    title: 'fix: bump yaml',
    head: 'reviewed',
  });
});

test('rejects skipped, blocking, stale and non-CodeRabbit reviews', async () => {
  for (const review of [
    { state: 'COMMENTED' },
    { state: 'CHANGES_REQUESTED' },
    { state: 'DISMISSED' },
    { commit_id: 'old' },
    { user: { login: 'maintainer' } },
  ]) {
    assert.deepEqual(await attempt({ review }), []);
  }
});

test('merges an already green PR while requiring the exact reviewed head', async () => {
  assert.deepEqual(await attempt({ current: { mergeable_state: 'clean' } }), [
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
  ]);
});

test('restricts write access to ready same-repository Dependabot PRs on main', async () => {
  for (const pull of [
    { user: { login: 'maintainer' } },
    { draft: true },
    { base: { ref: 'staging' } },
    { head: { sha: 'reviewed', repo: { full_name: 'attacker/sandy' } } },
  ]) {
    assert.deepEqual(await attempt({ pull }), []);
  }
});

test('does not queue a pushed, closed or drafted PR after fetching its reviews', async () => {
  for (const current of [
    { head: { sha: 'new' } },
    { state: 'closed' },
    { draft: true },
    { auto_merge: {} },
    { base: { ref: 'staging' } },
    { mergeable: false },
  ]) {
    assert.deepEqual(await attempt({ current }), []);
  }
});
