import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureGit } from '../../../../test-support/git.js';
import { type CliIo, main } from './cli.js';
import { LocalReviewInputError } from './errors.js';
import { type LocalReviewResult, listReviews } from './history.js';
import { localReviewHome, pathExists } from './home.js';
import { renderText } from './render.js';
import { runLocalReview } from './run.js';

const AGENTS = fileURLToPath(new URL('../../../../agents', import.meta.url));
const directories: string[] = [];

const BASE_SOURCE = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
const HEAD_SOURCE =
  'export function add(a: number, b: number): number {\n  return a - b;\n}\n\nexport const sum = (values: number[]) => values.reduce(add, 0);\n';

const LOGIC_FINDING = {
  severity: 'P1',
  confidence: 4,
  agentKey: 'logic',
  category: 'logic',
  anchor: { repo: 'acme/widgets', path: 'src/math.ts', lineStart: 2, lineEnd: 2 },
  summary: 'add() subtracts its operands',
  evidence: 'src/math.ts:2 returns a - b, so sum([1, 2]) is -3.',
  suggestedFix: 'Return a + b.',
};

interface FakeCodexBehavior {
  /** This Agent's invocation exits 1. */
  failAgent?: string;
}

interface Invocation {
  agent: string;
  args: string[];
  cwd: string;
  files: string[];
  home: string | undefined;
  codexHome: string | undefined;
  prompt: string;
  /** What `origin/main` resolves to in the Agent's worktree. */
  baseRef: string | null;
}

/** Stands in for `codex exec --json`: one turn, then a findings payload per Agent. */
function fakeCodex(logPath: string, behavior: FakeCodexBehavior): string {
  return [
    '#!/usr/bin/env node',
    "import { execFileSync } from 'node:child_process';",
    "import { appendFileSync, readdirSync, readFileSync } from 'node:fs';",
    `const behavior = ${JSON.stringify(behavior)};`,
    `const logicFinding = ${JSON.stringify(LOGIC_FINDING)};`,
    "const prompt = readFileSync(0, 'utf8');",
    "const agent = prompt.includes('# Security Agent') ? 'security' : 'logic';",
    "const files = readdirSync('.', { recursive: true }).filter((file) => file !== '.git' && !file.startsWith('.git/'));",
    'let baseRef = null;',
    "try { baseRef = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { encoding: 'utf8' }).trim(); } catch {}",
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ agent, args: process.argv.slice(2), cwd: process.cwd(), files, home: process.env.HOME, codexHome: process.env.CODEX_HOME, prompt, baseRef }) + '\\n');`,
    "if (behavior.failAgent === agent) { process.stderr.write('model unavailable'); process.exit(1); }",
    "const payload = { findings: agent === 'logic' ? [logicFinding] : [], crossRepoSearch: { status: 'skipped', trigger: 'none', rationale: 'The change stays inside one Repo.' } };",
    'const events = [',
    "  { type: 'thread.started', thread_id: 'thread-' + agent },",
    "  { type: 'item.completed', item: { type: 'agent_message', text: '<findings>' + JSON.stringify(payload) + '</findings>' } },",
    "  { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } },",
    '];',
    "process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');",
    '',
  ].join('\n');
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await fixtureGit(['-C', cwd, ...args])).stdout;
}

interface Fixture {
  root: string;
  checkout: string;
  cliHome: string;
  sandyRoot: string;
  env: NodeJS.ProcessEnv;
  baseSha: string;
  headSha: string;
  invocations: () => Promise<Invocation[]>;
  /** Everything a Review must leave unchanged in the developer's checkout. */
  checkoutState: () => Promise<string>;
}

/** A clone of `acme/widgets` with one commit on `feature/sum` ahead of `origin/main`. */
async function fixture(behavior: FakeCodexBehavior = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-local-review-')));
  directories.push(root);
  const user = join(root, 'user');
  await mkdir(user);
  // Keep the developer's home, Git config, and credentials out of the Review.
  vi.stubEnv('HOME', user);
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');

  const seed = join(root, 'seed');
  await mkdir(join(seed, 'src'), { recursive: true });
  await git(root, 'init', '--quiet', '-b', 'main', seed);
  await writeFile(join(seed, 'src', 'math.ts'), BASE_SOURCE);
  await git(seed, 'add', '.');
  await git(seed, 'commit', '--quiet', '-m', 'Add math');
  const origin = join(root, 'remotes', 'acme', 'widgets.git');
  await mkdir(dirname(origin), { recursive: true });
  await git(root, 'clone', '--quiet', '--bare', seed, origin);
  const checkout = join(root, 'work', 'widgets');
  await mkdir(dirname(checkout), { recursive: true });
  await git(root, 'clone', '--quiet', origin, checkout);
  const baseSha = (await git(checkout, 'rev-parse', 'HEAD')).trim();
  await git(checkout, 'checkout', '--quiet', '-b', 'feature/sum');
  await writeFile(join(checkout, 'src', 'math.ts'), HEAD_SOURCE);
  await git(checkout, 'commit', '--quiet', '-am', 'Add sum');
  const headSha = (await git(checkout, 'rev-parse', 'HEAD')).trim();

  const sandyRoot = join(root, 'sandy');
  await cp(AGENTS, join(sandyRoot, 'agents'), { recursive: true });
  const cliHome = join(root, 'cli');
  await mkdir(join(cliHome, 'codex'), { recursive: true });
  // A placeholder: the fake Codex never reads it.
  await writeFile(join(cliHome, 'codex', 'auth.json'), '{}\n', { mode: 0o600 });
  const log = join(root, 'codex-invocations.jsonl');
  const executable = join(root, 'bin', 'codex.mjs');
  await mkdir(dirname(executable));
  await writeFile(executable, fakeCodex(log, behavior));
  await chmod(executable, 0o755);

  return {
    root,
    checkout,
    cliHome,
    sandyRoot,
    env: {
      PATH: process.env.PATH,
      SANDY_CLI_HOME: cliHome,
      SANDY_CODEX_EXECUTABLE: executable,
    },
    baseSha,
    headSha,
    invocations: async () => {
      const raw = await readFile(log, 'utf8').catch(() => '');
      return raw
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Invocation);
    },
    checkoutState: async () =>
      [
        await git(checkout, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
        await git(checkout, 'for-each-ref', '--format=%(refname) %(objectname)'),
        await git(checkout, 'worktree', 'list', '--porcelain'),
        await git(checkout, 'stash', 'list'),
        await git(checkout, 'config', '--local', '--list'),
      ].join('\n----\n'),
  };
}

function review(f: Fixture, options: { env?: NodeJS.ProcessEnv; instructions?: string } = {}) {
  return runLocalReview({
    sandyRoot: f.sandyRoot,
    cwd: f.checkout,
    env: options.env ?? f.env,
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  });
}

function capture(f: Fixture): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: f.checkout,
    env: f.env,
    sandyRoot: f.sandyRoot,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out,
    err,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('runLocalReview', () => {
  it('reviews the committed branch diff in an isolated worktree and saves the result', async () => {
    const f = await fixture();
    const before = await f.checkoutState();

    const result = await review(f, { instructions: 'Focus on arithmetic.' });

    expect(result).toMatchObject({
      status: 'completed',
      repository: 'acme/widgets',
      branch: 'feature/sum',
      head: f.headSha,
      base: { ref: 'origin/main', sha: f.baseSha, mergeBase: f.baseSha },
      changedLines: 4,
      warnings: [],
    });
    expect(result.confidenceScore).toEqual(expect.any(Number));
    expect(result.summary.trim()).not.toBe('');
    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: 'P1',
        confidence: 4,
        agentKey: 'logic',
        repo: 'acme/widgets',
        path: 'src/math.ts',
        lineStart: 2,
        lineEnd: 2,
        summary: 'add() subtracts its operands',
        suggestedFix: 'Return a + b.',
      }),
    ]);
    const usage = {
      inputTokens: 600,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 400,
      outputTokens: 50,
    };
    expect([...result.agents].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      expect.objectContaining({ key: 'logic', status: 'completed', findingCount: 1, usage }),
      expect.objectContaining({ key: 'security', status: 'completed', findingCount: 0, usage }),
    ]);
    const text = renderText(result);
    expect(text).toContain('1. [P1] logic · src/math.ts:2 · confidence 4/5 · logic');
    expect(text).toContain('600 input + 400 cached + 50 output tokens');

    const invocations = await f.invocations();
    expect(invocations.map((invocation) => invocation.agent).sort()).toEqual(['logic', 'security']);
    const checkoutDenial = `${JSON.stringify(f.checkout)}="deny"`;
    for (const invocation of invocations) {
      expect(invocation.cwd.startsWith(join(f.cliHome, 'worktrees'))).toBe(true);
      expect(invocation.files.sort()).toEqual(['src', 'src/math.ts']);
      expect(invocation.codexHome).toBe(join(f.cliHome, 'codex'));
      expect(invocation.home).not.toBe(join(f.root, 'user'));
      expect(invocation.args.slice(0, 4)).toEqual(['exec', '--json', '--model', 'gpt-6.1-sol']);
      expect(invocation.args.some((arg) => arg.includes(checkoutDenial))).toBe(true);
      expect(invocation.prompt).toContain(
        'Review local branch feature/sum before it is opened as a pull request.',
      );
      expect(invocation.prompt).toContain('Repository: acme/widgets');
      expect(invocation.prompt).toContain(`Base ref: main at ${f.baseSha}`);
      expect(invocation.prompt).toContain(`Head SHA: ${f.headSha}`);
      expect(invocation.prompt).not.toContain('PR URL:');
      expect(invocation.prompt).toContain(
        'Requester focus for this Review:\n<<<\nFocus on arithmetic.\n>>>',
      );
      expect(invocation.prompt).toContain('-  return a + b;\n+  return a - b;');
    }

    expect((await listReviews(localReviewHome(f.env))).map((saved) => saved.id)).toEqual([
      result.id,
    ]);
    expect(await f.checkoutState()).toBe(before);
    expect(await readdir(join(f.cliHome, 'worktrees'))).toEqual([]);
    expect(await readdir(join(f.cliHome, 'mirrors'))).toEqual([]);
    expect(await pathExists(join(f.cliHome, 'review.lock'))).toBe(false);
  });

  it('shows reviewers the base at the fork point after the base moves on', async () => {
    const f = await fixture();
    // main gains a commit after feature/sum forks, and the developer has it.
    await git(f.checkout, 'checkout', '--quiet', 'main');
    await writeFile(join(f.checkout, 'src', 'later.ts'), 'export const later = 1;\n');
    await git(f.checkout, 'add', '.');
    await git(f.checkout, 'commit', '--quiet', '-m', 'Add later');
    await git(f.checkout, 'push', '--quiet', 'origin', 'main');
    await git(f.checkout, 'checkout', '--quiet', 'feature/sum');
    const tip = (await git(f.checkout, 'rev-parse', 'origin/main')).trim();

    const result = await review(f);

    expect(result).toMatchObject({
      status: 'completed',
      base: { ref: 'origin/main', sha: tip, mergeBase: f.baseSha },
      changedLines: 4,
    });
    const invocations = await f.invocations();
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(invocation.baseRef).toBe(f.baseSha);
      expect(invocation.prompt).toContain(`Base ref: main at ${f.baseSha}`);
      expect(invocation.prompt).not.toContain(tip);
      expect(invocation.prompt).not.toContain('later.ts');
    }
  });

  it('reviews only commits and warns about uncommitted work', async () => {
    const f = await fixture();
    await writeFile(join(f.checkout, 'src', 'math.ts'), `${HEAD_SOURCE}// unsaved idea\n`);
    await writeFile(join(f.checkout, 'notes.txt'), 'draft\n');

    const result = await review(f);

    expect(result.status).toBe('completed');
    expect(result.warnings).toEqual([
      '2 uncommitted changes are not part of this review; only commits are reviewed',
    ]);
    const invocations = await f.invocations();
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(invocation.files.sort()).toEqual(['src', 'src/math.ts']);
      expect(invocation.prompt).not.toContain('unsaved idea');
    }
  });

  it('marks the Review incomplete and unscored when a reviewer fails', async () => {
    const f = await fixture({ failAgent: 'security' });

    const result = await review(f);

    expect(result.status).toBe('incomplete');
    expect(result.confidenceScore).toBeNull();
    expect(result.agents.find((agent) => agent.key === 'security')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('model unavailable'),
    });
    expect(result.findings.map((finding) => finding.path)).toEqual(['src/math.ts']);
  });

  it('declines a diff over the changed-line limit without running reviewers', async () => {
    const f = await fixture();

    const result = await review(f, { env: { ...f.env, SANDY_REVIEW_MAX_CHANGED_LINES: '3' } });

    expect(result).toMatchObject({
      status: 'declined',
      changedLines: 4,
      summary:
        'Review declined: 4 changed lines exceed the 3-line limit. Split the branch or raise SANDY_REVIEW_MAX_CHANGED_LINES.',
    });
    expect(await f.invocations()).toEqual([]);
    expect((await listReviews(localReviewHome(f.env))).map((saved) => saved.id)).toEqual([
      result.id,
    ]);
  });

  it('hides the paths in SANDY_REVIEW_HIDDEN_PATHS from every reviewer', async () => {
    const f = await fixture();
    const toolLogin = join(f.root, 'user', '.tool');
    await mkdir(toolLogin);

    await review(f, { env: { ...f.env, SANDY_REVIEW_HIDDEN_PATHS: toolLogin } });

    const invocations = await f.invocations();
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(
        invocation.args.some((arg) => arg.includes(`${JSON.stringify(toolLogin)}="deny"`)),
      ).toBe(true);
    }
  });

  it('reports nothing to review on the base branch, before checking the login', async () => {
    const f = await fixture();
    await git(f.checkout, 'checkout', '--quiet', 'main');
    await rm(join(f.cliHome, 'codex', 'auth.json'));

    const result = await review(f);

    expect(result).toMatchObject({
      status: 'no_changes',
      changedLines: 0,
      summary: 'No committed changes between origin/main and HEAD; commit your work to review it.',
    });
    expect(await f.invocations()).toEqual([]);
    expect(await listReviews(localReviewHome(f.env))).toEqual([]);
  });

  it('requires the dedicated Codex login before reviewing changes', async () => {
    const f = await fixture();
    await rm(join(f.cliHome, 'codex', 'auth.json'));

    await expect(review(f)).rejects.toThrow(
      new LocalReviewInputError('sandy review needs its own Codex login; run `sandy login` first'),
    );
    expect(await f.invocations()).toEqual([]);
  });

  it('refuses CLI state inside the reviewed checkout', async () => {
    const f = await fixture();

    await expect(
      review(f, { env: { ...f.env, SANDY_CLI_HOME: join(f.checkout, '.sandy') } }),
    ).rejects.toThrow(/^The sandy CLI home .* is inside the checkout /);
  });

  it('rejects instructions over the prompt limit', async () => {
    const f = await fixture();

    await expect(review(f, { instructions: 'x'.repeat(4001) })).rejects.toThrow(
      '--instructions is limited to 4000 characters',
    );
  });
});

describe('sandy review', () => {
  it('prints JSON, then shows and lists the saved Review', async () => {
    const f = await fixture();
    const reviewIo = capture(f);

    expect(await main(['review', '--json', '--quiet'], reviewIo)).toBe(0);
    const printed = JSON.parse(reviewIo.out.join('')) as LocalReviewResult;
    expect(printed.status).toBe('completed');
    expect(reviewIo.err).toEqual([]);

    const showIo = capture(f);
    expect(await main(['review', 'show', printed.id.slice(0, 18), '--json'], showIo)).toBe(0);
    expect(JSON.parse(showIo.out.join(''))).toEqual(printed);

    const listIo = capture(f);
    expect(await main(['review', 'list', '--json'], listIo)).toBe(0);
    expect(JSON.parse(listIo.out.join(''))).toEqual([
      {
        id: printed.id,
        status: 'completed',
        repository: 'acme/widgets',
        branch: 'feature/sum',
        head: f.headSha,
        confidenceScore: printed.confidenceScore,
        findingCount: 1,
        finishedAt: printed.finishedAt,
      },
    ]);
  });

  it('exits 1 for a declined Review and logs progress on stderr', async () => {
    const f = await fixture();
    const io = { ...capture(f), env: { ...f.env, SANDY_REVIEW_MAX_CHANGED_LINES: '1' } };

    expect(await main(['review'], io)).toBe(1);
    expect(io.out.join('')).toContain('declined: the diff is too large to review');
    expect(io.err.join('')).toContain('[sandy] Product configuration: the GitHub Action defaults');
  });
});
