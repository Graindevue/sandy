import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareBenchmarkFixtures } from './review-benchmark-fixtures.mjs';

const exec = promisify(execFile);
const sandyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { CloneManager } = await import(
  join(sandyRoot, 'packages/bot-worker/dist/git/clone-manager.js')
);
const { CodexAppServerRunner } = await import(
  join(sandyRoot, 'packages/bot-worker/dist/worker/codex-app-server-runner.js')
);

/** Reproduce benchmark priming through the shipped adapter, without login or model requests. */
export async function runPreparationProbe(executable = 'codex', outputPath) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-primer-probe-')));
  const authRoot = await realpath(
    await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'sandy-primer-home-')),
  );
  const codexHome = join(authRoot, 'auth');
  const snapshots = join(root, 'download-snapshots');
  const journal = join(root, 'results.json.jsonl');
  const fixtureEvidence = join(root, 'results.json.fixtures');
  const signal = AbortSignal.timeout(90_000);
  const phases = [];
  let suite;
  const outcomes = [];
  try {
    await mkdir(codexHome);
    const environment = { PATH: process.env.PATH, HOME: authRoot, CODEX_HOME: codexHome };
    const version = (
      await exec(executable, ['--version'], { env: environment, timeout: 10_000 })
    ).stdout.trim();
    assert.equal(version, 'codex-cli 0.162.0', 'Use the exact deployed Codex pin');
    suite = await prepareBenchmarkFixtures(root);
    const fixture = suite.fixtures.find((fixture) => fixture.id === 'defects');
    assert.ok(fixture);
    const identities = new Map([
      [fixture.repo.name, fixture.origin],
      [fixture.sibling.repo.name, fixture.sibling.origin],
    ]);
    const clones = new CloneManager({
      baseDir: join(root, 'clones'),
      cloneUrl: (repo) => identities.get(repo.name),
      signal,
    });
    await clones.ensureCloned(fixture.repo);
    await clones.ensureCloned(fixture.sibling.repo);
    const sibling = await clones.createWorktree(fixture.sibling.repo, {
      reviewJobId: 'benchmark-sibling-defects',
      sha: fixture.sibling.sha,
    });
    const backing = new Map();
    // Match the live benchmark's prepared-worktree and protected-cache-parent layout.
    const protectedPaths = [
      outputPath ?? join(root, 'results.json'),
      journal,
      snapshots,
      fixtureEvidence,
      fixture.origin,
      fixture.sibling.origin,
      join(codexHome, '..', 'sandy-dependency-downloads-install'),
      join(codexHome, '..', 'sandy-dependency-downloads'),
      ...(process.env.GITHUB_APP_PRIVATE_KEY_PATH
        ? [resolve(process.env.GITHUB_APP_PRIVATE_KEY_PATH)]
        : []),
      ...(process.env.RUNNER_TEMP ? [join(process.env.RUNNER_TEMP, '_runner_file_commands')] : []),
      ...[
        'GITHUB_ENV',
        'GITHUB_OUTPUT',
        'GITHUB_PATH',
        'GITHUB_STEP_SUMMARY',
        'GITHUB_STATE',
      ].flatMap((key) => (process.env[key] ? [resolve(process.env[key])] : [])),
    ];
    const runner = new CodexAppServerRunner({
      codexHome,
      toolHome: join(root, 'installer-home'),
      executable,
      enableManagedRuntime: true,
      testMode: 'targeted',
      installTimeoutMs: 30_000,
      protectedPaths,
      logger: {
        info(message) {
          if (phases.length < 30) phases.push(message.slice(0, 500));
        },
      },
      dependencyDownloadCache: {
        async restore({ key, storePath }) {
          const snapshot = backing.get(key);
          if (!snapshot) return undefined;
          await cp(snapshot, storePath, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
          return key;
        },
        async save({ key, storePath }) {
          await mkdir(snapshots, { recursive: true });
          const destination = join(snapshots, 'download');
          await cp(storePath, destination, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
          backing.set(key, destination);
        },
      },
    });
    suite.resetDownloads();
    for (const state of ['prime', 'warm']) {
      const workspace = await clones.createWorktree(fixture.repo, {
        reviewJobId: `benchmark-${state}-defects`,
        sha: fixture.headSha,
      });
      const result = await runner.installDependencies({
        worktreePath: workspace.path,
        cacheKey: 'evaluation/producer',
        signal,
      });
      outcomes.push({
        state,
        status: result.status,
        cache: result.cache,
        error: result.status === 'failed' ? result.error.slice(0, 4000) : undefined,
        downloads: suite.downloads(),
        saved: backing.size,
      });
      const report = {
        platform: process.platform,
        node: process.version,
        codexVersion: version,
        packageManager: fixture.packageManager,
        outcomes,
        phases,
      };
      if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      assert.equal(
        result.status,
        'installed',
        'Controlled warm-cache priming failed: installation',
      );
      assert.ok(backing.size > 0, 'Controlled warm-cache priming failed: no published downloads');
      if (state === 'warm') assert.equal(result.cache?.restore, 'hit');
      const resolved = await exec(
        'node',
        ['-e', "console.log(require('zod/package.json').version)"],
        { cwd: workspace.path, env: environment, timeout: 10_000 },
      );
      assert.equal(resolved.stdout.trim(), '4.1.12');
      assert.ok(
        (await readFile(join(workspace.path, 'package-lock.json'), 'utf8')).includes('zod.tgz'),
      );
      await clones.removeWorktree(workspace);
    }
    assert.equal(suite.downloads().requests, 1, 'Warm preparation must reuse the actual download');
    await clones.removeWorktree(sibling);
    return outcomes;
  } finally {
    await suite?.close();
    await rm(root, { recursive: true, force: true });
    await rm(authRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runPreparationProbe(process.argv[2] ?? 'codex', process.argv[3]);
