// Answers a `@sandy` request whose run failed before Sandy posted anything.
// Only fixed step names and outcomes reach the PR: step output can carry
// reviewed-code text and stays in the run log behind the link.
import { positiveInteger } from './request.mjs';

export function failureComment({ steps, runUrl }) {
  const failed = steps.find(([, outcome]) => outcome === 'failure');
  const cause = failed === undefined ? 'A setup step failed' : `The step "${failed[0]}" failed`;
  return [
    `**Sandy could not finish this review.** ${cause}. No findings were posted for this request.`,
    `Details are in the [run log](${runUrl}). Post a new \`@sandy\` comment to try again.`,
  ].join('\n\n');
}

if (process.argv[1]?.endsWith('/report-failure.mjs')) {
  const {
    GH_TOKEN: token,
    GITHUB_API_URL: api = 'https://api.github.com',
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: runId,
    GITHUB_SERVER_URL: server = 'https://github.com',
    SANDY_PR_NUMBER: pullNumber,
    SANDY_STEP_OUTCOMES: outcomes,
  } = process.env;
  if (!token || !repository || !runId) {
    throw new Error('The failure report requires a token, repository and run id');
  }
  const body = failureComment({
    steps: JSON.parse(outcomes ?? '[]'),
    runUrl: `${server}/${repository}/actions/runs/${runId}`,
  });
  const response = await fetch(
    `${api}/repos/${repository}/issues/${positiveInteger(pullNumber)}/comments`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    throw new Error(`Posting the failure report returned HTTP ${response.status}`);
  }
}
