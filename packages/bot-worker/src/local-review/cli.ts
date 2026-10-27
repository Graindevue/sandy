#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LocalReviewInputError, LocalReviewInterrupted } from './errors.js';
import { findReview, type LocalReviewResult, listReviews } from './history.js';
import { localReviewHome } from './home.js';
import { LOGIN_METHODS, type LoginCommand, runCodexLogin } from './login.js';
import { listEntry, renderJson, renderList, renderText } from './render.js';
import { runLocalReview } from './run.js';

const USAGE = `Review the committed changes on your branch before you open a pull request.

Usage:
  sandy review [options]           Review HEAD against the branch it merges into
  sandy review show [id] [--json]  Print a saved Review; the newest by default
  sandy review list [--json]       List saved Reviews, newest first
  sandy login [method]             Sign the Codex login for Reviews in
  sandy login status               Show whether it is signed in
  sandy logout                     Sign it out

Sign-in methods are --device-auth, --with-api-key, and --with-access-token; the
last two read the key or token from stdin. Without one, Codex signs in through
the browser. Login commands also take --codex-home <dir>.

Review options:
  -b, --branch <base>       Base to diff against (default: origin/HEAD, origin/main, origin/master)
      --json                Print the result as one JSON object
      --text, --agent       Print plain text (the default)
      --instructions <text> Focus for this Review, up to 4000 characters
      --fast                Ask Codex for fast mode
      --model <model>       Run every reviewer on this model
      --repo <owner/name>   The Repo, when origin does not name it
      --config <path>       Sandy bot.yaml to use (default: SANDY_CONFIG_PATH)
      --codex-home <dir>    Codex login for Reviews (default: ~/.sandy/cli/codex)
  -q, --quiet               Print only warnings on stderr
  -h, --help                Show this help

Only commits are reviewed. The branch is never fetched and nothing is posted;
sibling Repos of a multi-repo Product are cloned from origin's host. Progress
goes to stderr and the result to stdout. Each reviewer takes several minutes.

Exit status: 0 reviewed or nothing to review; 1 the Review failed, was
incomplete, or was declined; 2 invalid input or setup; 130 or 143 interrupted.
`;

/** Git variables that would point every Git command at another repository or index. */
const REPOSITORY_GIT_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_SHALLOW_FILE',
];

export interface CliIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
  /** Root holding `agents/`; defaults to the Sandy checkout this file is built in. */
  sandyRoot?: string;
}

/** Run one command and return its exit status. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'review':
        return await reviewCommand(rest, io);
      case 'login':
        return await loginCommand(rest[0] === 'status' ? 'status' : 'login', rest, io);
      case 'logout':
        return await loginCommand('logout', rest, io);
      case '-h':
      case '--help':
      case 'help':
        io.stdout(USAGE);
        return 0;
      case undefined:
        io.stderr(USAGE);
        return 2;
      default:
        throw new LocalReviewInputError(`Unknown command ${command}; run sandy --help`);
    }
  } catch (error) {
    if (error instanceof LocalReviewInterrupted) {
      io.stderr(`sandy: ${error.message}; nothing was saved\n`);
      return error.exitCode;
    }
    if (error instanceof LocalReviewInputError || isParseArgsError(error)) {
      io.stderr(`sandy: ${describeError(error)}\n`);
      return 2;
    }
    io.stderr(`sandy: ${describeError(error)}\n`);
    return 1;
  }
}

async function reviewCommand(args: readonly string[], io: CliIo): Promise<number> {
  if (args[0] === 'show') return await showCommand(args.slice(1), io);
  if (args[0] === 'list') return await listCommand(args.slice(1), io);
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      branch: { type: 'string', short: 'b' },
      json: { type: 'boolean' },
      text: { type: 'boolean' },
      agent: { type: 'boolean' },
      instructions: { type: 'string' },
      fast: { type: 'boolean' },
      model: { type: 'string' },
      repo: { type: 'string' },
      config: { type: 'string' },
      'codex-home': { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.stdout(USAGE);
    return 0;
  }
  if (values.json === true && (values.text === true || values.agent === true)) {
    throw new LocalReviewInputError('Choose one of --json and --text');
  }
  const configPath = values.config ?? (io.env.SANDY_CONFIG_PATH?.trim() || undefined);
  const review = await runLocalReview({
    sandyRoot: io.sandyRoot ?? defaultSandyRoot(),
    cwd: io.cwd,
    env: io.env,
    ...(values.branch === undefined ? {} : { base: values.branch }),
    ...(values.repo === undefined ? {} : { repo: values.repo }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(values['codex-home'] === undefined ? {} : { codexHome: values['codex-home'] }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.instructions === undefined ? {} : { instructions: values.instructions }),
    fastMode: values.fast === true,
    ...(io.signal === undefined ? {} : { signal: io.signal }),
    log: values.quiet === true ? () => {} : (message) => io.stderr(`[sandy] ${message}\n`),
    warn: (message) => io.stderr(`[sandy] warning: ${message}\n`),
  });
  io.stdout(values.json === true ? renderJson(review) : renderText(review));
  return reviewExitCode(review);
}

async function showCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  });
  if (positionals.length > 1) throw new LocalReviewInputError('sandy review show takes one id');
  const [id] = positionals;
  const review = await findReview(localReviewHome(io.env), id);
  if (review === null) {
    io.stderr(id === undefined ? 'sandy: No saved Reviews\n' : `sandy: No saved Review ${id}\n`);
    return 1;
  }
  io.stdout(values.json === true ? renderJson(review) : renderText(review));
  return 0;
}

async function listCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: { json: { type: 'boolean' } },
  });
  const reviews = await listReviews(localReviewHome(io.env));
  io.stdout(
    values.json === true
      ? `${JSON.stringify(reviews.map(listEntry), null, 2)}\n`
      : renderList(reviews),
  );
  return 0;
}

async function loginCommand(
  command: LoginCommand,
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { values } = parseArgs({
    args: command === 'status' ? args.slice(1) : [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'device-auth': { type: 'boolean' },
      'with-api-key': { type: 'boolean' },
      'with-access-token': { type: 'boolean' },
      'codex-home': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.stdout(USAGE);
    return 0;
  }
  const methods = LOGIN_METHODS.filter((method) => values[method] === true);
  if (methods.length > 1) {
    throw new LocalReviewInputError(
      'Choose one of --device-auth, --with-api-key, and --with-access-token',
    );
  }
  const [method] = methods;
  return await runCodexLogin({
    home: localReviewHome(io.env, values['codex-home']),
    command,
    ...(method === undefined ? {} : { method }),
    env: io.env,
  });
}

/** A declined Review exits 1 because the branch was not reviewed. */
export function reviewExitCode(review: Pick<LocalReviewResult, 'status'>): number {
  return review.status === 'completed' || review.status === 'no_changes' ? 0 : 1;
}

/** `packages/bot-worker/{src,dist}/local-review/` sits four levels below the Sandy root. */
function defaultSandyRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  for (const name of REPOSITORY_GIT_VARIABLES) delete process.env[name];
  process.env.GIT_TERMINAL_PROMPT ??= '0';
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // A second signal skips the cleanup of worktrees and the lock.
      if (controller.signal.aborted) process.exit(signal === 'SIGINT' ? 130 : 143);
      process.stderr.write(`\n[sandy] ${signal}: stopping the Review; repeat to quit at once\n`);
      controller.abort(new LocalReviewInterrupted(signal));
    });
  }
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
  });
}
