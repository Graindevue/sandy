import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function validateManagedAuth(contents) {
  const auth = JSON.parse(contents);
  if (
    auth.auth_mode !== 'chatgpt' ||
    typeof auth.tokens?.refresh_token !== 'string' ||
    !auth.tokens.refresh_token ||
    typeof auth.tokens?.access_token !== 'string' ||
    !auth.tokens.access_token
  ) {
    throw new Error('CODEX_AUTH_JSON must contain a dedicated, file-backed ChatGPT Codex login');
  }
  return auth;
}

export function authMasks(contents) {
  const auth = validateManagedAuth(contents);
  return [contents, ...Object.values(auth.tokens)].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
}

export async function seedAuth(codexHome, contents) {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);
  const authPath = join(codexHome, 'auth.json');
  try {
    await stat(authPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    validateManagedAuth(contents);
    await writeFile(authPath, contents, { flag: 'wx', mode: 0o600 });
  }
  const current = await readFile(authPath, 'utf8');
  validateManagedAuth(current);
  await chmod(authPath, 0o600);
  await writeFile(
    join(codexHome, 'config.toml'),
    'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n',
    { mode: 0o600 },
  );
  return current;
}

async function main() {
  const env = process.env;
  const command = process.argv[2];
  const codexHome = env.CODEX_HOME;
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!codexHome || !keyPath)
    throw new Error('The action must prepare its dedicated credential paths');
  if (command === 'cleanup') {
    await rm(codexHome, { recursive: true, force: true });
    await rm(keyPath, { force: true });
    return;
  }
  const repository = env.GITHUB_REPOSITORY;
  const environment = env.SANDY_AUTH_ENVIRONMENT;
  if (!repository || !environment || !env.GH_TOKEN) {
    throw new Error('A repository, auth environment and fresh GitHub App token are required');
  }
  if (command === 'seed') {
    // Refuse repository-secret fallback: the rotating environment secret must
    // exist, and write access must be proven before Codex can rotate any token.
    execFileSync(
      'gh',
      ['api', `repos/${repository}/environments/${environment}/secrets/CODEX_AUTH_JSON`],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    execFileSync(
      'gh',
      ['api', `repos/${repository}/environments/${environment}/secrets/public-key`],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    const current = await seedAuth(codexHome, env.CODEX_AUTH_JSON ?? '');
    for (const value of authMasks(current)) mask(value);
    if (!env.SANDY_APP_PRIVATE_KEY) throw new Error('The Sandy App private key is missing');
    await writeFile(keyPath, env.SANDY_APP_PRIVATE_KEY, { mode: 0o600 });
  } else if (command === 'persist') {
    const current = await readFile(join(codexHome, 'auth.json'), 'utf8');
    for (const value of authMasks(current)) mask(value);
    execFileSync(
      'gh',
      ['secret', 'set', 'CODEX_AUTH_JSON', '--repo', repository, '--env', environment],
      {
        input: current,
        stdio: ['pipe', 'ignore', 'inherit'],
      },
    );
  } else {
    throw new Error('Expected seed, persist or cleanup');
  }
}

function mask(value) {
  const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  process.stdout.write(`::add-mask::${escaped}\n`);
}

if (process.argv[1]?.endsWith('/auth.mjs')) {
  await main();
}
