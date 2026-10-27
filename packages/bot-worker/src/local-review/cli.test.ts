import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CliIo, main, reviewExitCode } from './cli.js';
import { localReviewHome, pathExists } from './home.js';

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-local-cli-')));
  vi.stubEnv('HOME', join(root, 'user'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function cli(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd: root,
    env: { PATH: process.env.PATH, SANDY_CLI_HOME: join(root, 'cli'), ...env },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return {
    run: (...argv: string[]) => main(argv, io),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/** Records how `sandy login` runs Codex; it never touches a real login. */
async function recordingCodex(
  exitCode = 0,
): Promise<{ executable: string; calls: () => Promise<unknown[]> }> {
  const log = join(root, 'codex-calls.jsonl');
  const executable = join(root, 'bin', 'codex.mjs');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME,
  lockHeld: existsSync(join(process.env.SANDY_CLI_HOME, 'review.lock')),
}) + '\\n');
process.exit(${exitCode});
`,
  );
  await chmod(executable, 0o755);
  return {
    executable,
    calls: async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
  };
}

describe('sandy', () => {
  it('prints help and rejects unknown input with status 2', async () => {
    const help = cli();
    expect(await help.run('--help')).toBe(0);
    expect(help.stdout()).toContain('sandy review [options]');
    expect(help.stdout()).toContain('Exit status: 0 reviewed or nothing to review');

    const empty = cli();
    expect(await empty.run()).toBe(2);
    expect(empty.stderr()).toContain('Usage:');

    const unknown = cli();
    expect(await unknown.run('reveiw')).toBe(2);
    expect(unknown.stderr()).toBe('sandy: Unknown command reveiw; run sandy --help\n');

    const flag = cli();
    expect(await flag.run('review', '--colour')).toBe(2);
    expect(flag.stderr()).toContain("Unknown option '--colour'");

    const formats = cli();
    expect(await formats.run('review', '--json', '--agent')).toBe(2);
    expect(formats.stderr()).toBe('sandy: Choose one of --json and --text\n');
  });

  it('reports when there is no saved Review to show', async () => {
    const show = cli();
    expect(await show.run('review', 'show')).toBe(1);
    expect(show.stderr()).toBe('sandy: No saved Reviews\n');

    const missing = cli();
    expect(await missing.run('review', 'show', '20261025')).toBe(1);
    expect(missing.stderr()).toBe('sandy: No saved Review 20261025\n');

    const list = cli();
    expect(await list.run('review', 'list')).toBe(0);
    expect(list.stdout()).toBe('No saved Reviews.\n');

    const json = cli();
    expect(await json.run('review', 'list', '--json')).toBe(0);
    expect(JSON.parse(json.stdout())).toEqual([]);
  });

  it('exits 0 only for a completed Review or one with nothing to review', () => {
    expect(reviewExitCode({ status: 'completed' })).toBe(0);
    expect(reviewExitCode({ status: 'no_changes' })).toBe(0);
    expect(reviewExitCode({ status: 'incomplete' })).toBe(1);
    expect(reviewExitCode({ status: 'declined' })).toBe(1);
    expect(reviewExitCode({ status: 'failed' })).toBe(1);
  });
});

describe('sandy login', () => {
  it('signs the dedicated Codex home in with the file credential store under the lock', async () => {
    const codex = await recordingCodex();
    const run = cli({ SANDY_CODEX_EXECUTABLE: codex.executable });
    const home = localReviewHome({ SANDY_CLI_HOME: join(root, 'cli') });

    expect(await run.run('login', '--device-auth')).toBe(0);

    expect(await codex.calls()).toEqual([
      {
        args: ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
        codexHome: home.codexHome,
        lockHeld: true,
      },
    ]);
    expect(await pathExists(home.lock)).toBe(false);
  });

  it('checks status without the lock, honoring --codex-home', async () => {
    const codex = await recordingCodex(1);
    const run = cli({ SANDY_CODEX_EXECUTABLE: codex.executable });
    const codexHome = join(root, 'login', 'codex');

    expect(await run.run('login', 'status', '--codex-home', codexHome)).toBe(1);

    expect(await codex.calls()).toEqual([
      {
        args: ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'],
        codexHome,
        lockHeld: false,
      },
    ]);
  });

  it('signs out without a sign-in method', async () => {
    const codex = await recordingCodex();
    const run = cli({ SANDY_CODEX_EXECUTABLE: codex.executable });

    expect(await run.run('logout')).toBe(0);
    expect(await codex.calls()).toMatchObject([
      { args: ['-c', 'cli_auth_credentials_store="file"', 'logout'] },
    ]);

    const method = cli({ SANDY_CODEX_EXECUTABLE: codex.executable });
    expect(await method.run('logout', '--device-auth')).toBe(2);
    expect(method.stderr()).toBe('sandy: sandy logout takes no sign-in method\n');
  });

  it('rejects two sign-in methods, the personal Codex login, and a missing Codex CLI', async () => {
    const methods = cli();
    expect(await methods.run('login', '--device-auth', '--with-api-key')).toBe(2);
    expect(methods.stderr()).toBe(
      'sandy: Choose one of --device-auth, --with-api-key, and --with-access-token\n',
    );

    const personal = cli();
    expect(await personal.run('login', '--codex-home', join(root, 'user', '.codex'))).toBe(2);
    expect(personal.stderr()).toContain('~/.codex is never used or copied');

    const missing = cli({ SANDY_CODEX_EXECUTABLE: join(root, 'bin', 'no-codex') });
    expect(await missing.run('login')).toBe(2);
    expect(missing.stderr()).toBe(
      `sandy: ${join(root, 'bin', 'no-codex')} was not found; install the Codex CLI or set SANDY_CODEX_EXECUTABLE\n`,
    );
  });
});
