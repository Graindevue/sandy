function isEligible(pull, fullName, defaultBranch) {
  return (
    pull.state === 'open' &&
    pull.user.login === 'dependabot[bot]' &&
    !pull.draft &&
    pull.base.ref === defaultBranch &&
    pull.head.repo?.full_name === fullName
  );
}

export async function mergeDependabotUpdates({ github, context, core }) {
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository.default_branch;
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open' });
  let failed = false;
  for (const pull of pulls) {
    if (!isEligible(pull, `${owner}/${repo}`, defaultBranch)) continue;
    try {
      const reviews = await github.paginate(github.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pull.number,
      });
      const review = reviews.findLast((entry) => entry.user.login === 'coderabbitai[bot]');
      if (review?.state !== 'APPROVED' || review.commit_id !== pull.head.sha) continue;

      // Re-read after fetching reviews; pushes invalidate the reviewed head.
      const { data: current } = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: pull.number,
      });
      if (!isEligible(current, `${owner}/${repo}`, defaultBranch)) continue;
      if (current.head.sha !== review.commit_id || current.mergeable_state !== 'clean') continue;

      const { data } = await github.rest.pulls.merge({
        owner,
        repo,
        pull_number: current.number,
        sha: current.head.sha,
        merge_method: 'squash',
        commit_title: `fix: ${current.title.replace(/^[^:]+:\s*/, '')}`,
        commit_message: '',
      });
      if (!data.merged) throw new Error(data.message);
      core.info(`Merged #${current.number} after CodeRabbit approval and required checks.`);

      // GITHUB_TOKEN merges suppress push events; dispatch trusted main checks explicitly.
      for (const workflow_id of ['ci.yml', 'security.yml']) {
        await github.rest.actions.createWorkflowDispatch({
          owner,
          repo,
          workflow_id,
          ref: defaultBranch,
        });
      }
    } catch (error) {
      failed = true;
      core.warning(`Could not finish auto-merge for #${pull.number}: ${error.message}`);
    }
  }
  if (failed) core.setFailed('Some Dependabot PRs could not be processed; see warnings above.');
}
