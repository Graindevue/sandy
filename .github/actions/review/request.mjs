export function reviewRequest(eventName, payload, runAttempt = '1') {
  if (eventName !== 'issue_comment') {
    throw new Error(`Unsupported review event: ${eventName}`);
  }
  if (String(runAttempt) !== '1') {
    throw new Error('Post a new @sandy comment instead of rerunning an earlier workflow');
  }
  if (!payload.issue?.pull_request || payload.action !== 'created') {
    throw new Error('A newly created pull request comment is required');
  }
  if (!/(?:^|\s)@sandy(?![\w-])/i.test(payload.comment?.body ?? '')) {
    throw new Error('The comment must mention @sandy');
  }
  if (payload.comment.user?.type !== 'User') {
    throw new Error('Only human collaborators can request reviews');
  }
  return { prNumber: positiveInteger(payload.issue.number), actor: payload.comment.user.login };
}

export function positiveInteger(value) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error('Pull request number must be a positive integer');
  }
  return Number(text);
}

export function assertTrustedRequest(repository, pullRequest, permission, ref, actor) {
  if (!repository.private || repository.fork) {
    throw new Error('Subscription authentication is restricted to private, non-fork repositories');
  }
  if (ref !== `refs/heads/${repository.default_branch}`) {
    throw new Error('The workflow must run from the default branch');
  }
  if (!actor || !['write', 'maintain', 'admin'].includes(permission)) {
    throw new Error('The requesting actor must have repository write permission');
  }
  if (
    pullRequest.state !== 'open' ||
    !pullRequest.head?.repo ||
    pullRequest.head.repo.id !== repository.id ||
    pullRequest.base?.repo?.id !== repository.id
  ) {
    throw new Error(
      'Only open pull requests with branches in the reviewed repository are accepted',
    );
  }
}
