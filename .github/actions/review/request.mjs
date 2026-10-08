export function reviewRequest(eventName, payload, appId, dispatchedPr) {
  if (eventName === 'issue_comment') {
    if (!payload.issue?.pull_request || payload.action !== 'created') {
      throw new Error('A newly created pull request comment is required');
    }
    if (!/(?:^|\s)@(?:agent-sandy|sandy)\s+review\b/i.test(payload.comment?.body ?? '')) {
      throw new Error('The comment must mention @sandy review or @agent-sandy review');
    }
    if (payload.comment.user?.type !== 'User') {
      throw new Error('Only human collaborators can request reviews');
    }
    return { prNumber: positiveInteger(payload.issue.number), actor: payload.comment.user.login };
  }
  if (eventName === 'workflow_dispatch') {
    return { prNumber: positiveInteger(dispatchedPr), actor: payload.sender?.login };
  }
  if (eventName === 'check_run') {
    if (
      payload.action !== 'rerequested' ||
      String(payload.check_run?.app?.id) !== String(appId) ||
      payload.check_run?.name !== 'Sandy'
    ) {
      throw new Error('Only a Sandy Check Run re-request is accepted');
    }
    const prs = payload.check_run.pull_requests ?? [];
    if (prs.length !== 1) {
      throw new Error('The Sandy Check Run must identify exactly one pull request; use a mention');
    }
    return { prNumber: positiveInteger(prs[0].number), actor: payload.sender?.login };
  }
  throw new Error(`Unsupported review event: ${eventName}`);
}

export function positiveInteger(value) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error('Pull request number must be a positive integer');
  }
  return Number(text);
}

export function assertTrustedRequest(
  repository,
  pullRequest,
  permission,
  ref,
  actor,
  workflow = {},
) {
  if (!repository.private || repository.fork) {
    throw new Error('Subscription authentication is restricted to private, non-fork repositories');
  }
  if (ref !== `refs/heads/${repository.default_branch}`) {
    const auditedSmoke =
      workflow.eventName === 'workflow_dispatch' &&
      /^[a-f0-9]{40}$/i.test(workflow.trustedSha ?? '') &&
      workflow.sha?.toLowerCase() === workflow.trustedSha?.toLowerCase();
    if (!auditedSmoke) {
      throw new Error(
        'The workflow must run from the default branch or an exactly pinned manual smoke commit',
      );
    }
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
