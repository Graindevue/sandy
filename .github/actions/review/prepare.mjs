import { appendFile, copyFile, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertTrustedRequest, positiveInteger, reviewRequest } from './request.mjs';

const env = process.env;
const event = JSON.parse(await readFile(required('GITHUB_EVENT_PATH'), 'utf8'));
const request = reviewRequest(
  required('GITHUB_EVENT_NAME'),
  event,
  required('SANDY_INPUT_APP_ID'),
  env.SANDY_INPUT_PR_NUMBER,
);
if (request.prNumber !== positiveInteger(required('SANDY_INPUT_PR_NUMBER'))) {
  throw new Error('The requested PR does not match the authorized event');
}
const repositoryName = required('GITHUB_REPOSITORY');
if (!/^[\w.-]+\/[\w.-]+$/.test(repositoryName)) {
  throw new Error('Invalid GitHub repository name');
}
const repository = await github(`repos/${repositoryName}`);
const pullRequest = await github(`repos/${repositoryName}/pulls/${request.prNumber}`);
const permissions = await github(
  `repos/${repositoryName}/collaborators/${encodeURIComponent(request.actor ?? '')}/permission`,
);
assertTrustedRequest(
  repository,
  pullRequest,
  permissions.permission,
  env.GITHUB_REF,
  request.actor,
  {
    eventName: env.GITHUB_EVENT_NAME,
    sha: env.GITHUB_SHA,
    trustedSha: env.SANDY_INPUT_TRUSTED_WORKFLOW_SHA,
  },
);

const authEnvironment = required('SANDY_AUTH_ENVIRONMENT');
if (!/^[\w.-]+$/.test(authEnvironment)) {
  throw new Error('The auth environment must be a simple GitHub Environment name');
}
const sandyRoot = await realpath(resolve(required('GITHUB_ACTION_PATH'), '../../..'));
const sandyPackage = JSON.parse(await readFile(join(sandyRoot, 'package.json'), 'utf8'));
const pnpmVersion = sandyPackage.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
if (!pnpmVersion) throw new Error('Sandy must pin an exact pnpm packageManager version');
const scratch = await mkdtemp(join(required('RUNNER_TEMP'), 'sandy-review-'));
const configPath = join(scratch, 'bot.yaml');
if (env.SANDY_INPUT_CONFIG_PATH) {
  if (isAbsolute(env.SANDY_INPUT_CONFIG_PATH)) {
    throw new Error('config-path must be relative to the trusted caller checkout');
  }
  const workspace = await realpath(required('GITHUB_WORKSPACE'));
  const source = await realpath(resolve(workspace, env.SANDY_INPUT_CONFIG_PATH));
  const fromWorkspace = relative(workspace, source);
  if (fromWorkspace.startsWith('..') || isAbsolute(fromWorkspace)) {
    throw new Error('config-path must stay inside the trusted caller checkout');
  }
  await copyFile(source, configPath);
} else {
  const model = env.SANDY_INPUT_MODEL?.trim() || 'gpt-5.5';
  const slug = env.SANDY_INPUT_PRODUCT_SLUG?.trim() || repository.name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error('product-slug must contain only lowercase letters, numbers and hyphens');
  }
  const runtime = (effort) => ({ vendor: 'codex', model, effort });
  // JSON is valid YAML; serializing avoids YAML injection through action inputs.
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        products: [
          {
            slug,
            name: env.SANDY_INPUT_PRODUCT_NAME?.trim() || repository.name,
            repos: [
              {
                owner: repository.owner.login,
                name: repository.name,
                defaultBranch: repository.default_branch,
              },
            ],
            agents: {
              enable: ['logic', 'security', 'convex'],
              overrides: {
                logic: runtime('xhigh'),
                security: runtime('high'),
                convex: runtime('high'),
              },
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

await appendFile(required('GITHUB_OUTPUT'), `sandy-root=${sandyRoot}\n`);
await appendFile(required('GITHUB_OUTPUT'), `pnpm-version=${pnpmVersion}\n`);
for (const [name, value] of Object.entries({
  CODEX_HOME: join(scratch, 'codex'),
  OPENSRC_HOME: join(required('RUNNER_TEMP'), 'sandy-opensrc'),
  SANDY_CONFIG_PATH: configPath,
  SANDY_CLONE_DIR: join(scratch, 'repos'),
  SANDY_ACTION_SCRATCH: scratch,
  GITHUB_APP_PRIVATE_KEY_PATH: join(scratch, 'app.private-key.pem'),
})) {
  await appendFile(required('GITHUB_ENV'), `${name}=${value}\n`);
}

function required(name) {
  const value = env[name];
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be set to a single-line value`);
  }
  return value;
}

async function github(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${required('GH_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${path}`);
  }
  return response.json();
}
