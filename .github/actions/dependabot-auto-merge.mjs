function isEligible(pull, fullName, defaultBranch) {
  return (
    pull.state === 'open' &&
    pull.user.login === 'dependabot[bot]' &&
    !pull.draft &&
    pull.base.ref === defaultBranch &&
    pull.head.repo?.full_name === fullName
  );
}

export async function enableDependabotAutoMerge({ github, context, core }) {
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository.default_branch;
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open' });
  for (const pull of pulls) {
    if (!isEligible(pull, `${owner}/${repo}`, defaultBranch)) continue;
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
    if (current.head.sha !== review.commit_id || current.mergeable === false) continue;
    if (current.auto_merge) continue;

    const title = `fix: ${current.title.replace(/^[^:]+:\s*/, '')}`;
    if (current.mergeable_state === 'clean') {
      const { data } = await github.rest.pulls.merge({
        owner,
        repo,
        pull_number: current.number,
        sha: current.head.sha,
        merge_method: 'squash',
        commit_title: title,
        commit_message: '',
      });
      if (!data.merged) throw new Error(data.message);
      core.info(`Merged #${current.number} after CodeRabbit approval and required checks.`);
      continue;
    }

    await github.graphql(
      `mutation($id: ID!, $title: String!, $head: GitObjectID!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $id, mergeMethod: SQUASH, commitHeadline: $title, commitBody: "",
          expectedHeadOid: $head
        }) { pullRequest { number } }
      }`,
      {
        id: current.node_id,
        title,
        head: current.head.sha,
      },
    );
    core.info(`Enabled auto-merge for #${current.number} after CodeRabbit approval.`);
  }
}
