import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runManagedRuntimeProbe } from './codex-managed-runtime-probe.mjs';
import { prepareBenchmarkFixtures } from './review-benchmark-fixtures.mjs';

const exec = promisify(execFile);
const sandyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = join(sandyRoot, 'packages/bot-worker/dist');

async function liveBenchmark(options) {
  if (!options['ci-home'])
    throw new Error(
      'Explicit --ci-home is required; environment auth is never selected implicitly',
    );
  if (!options.out) throw new Error('--out is required');
  const codexHome = await realpath(resolve(options['ci-home']));
  let localHome;
  try {
    localHome = await realpath(join(homedir(), '.codex'));
  } catch {
    localHome = join(homedir(), '.codex');
  }
  if (codexHome === localHome || codexHome === (await realpath(homedir())))
    throw new Error('The interactive Codex home cannot be used for a live benchmark');
  if (!(await lstat(join(codexHome, 'auth.json'))).isFile())
    throw new Error('The explicit dedicated CI home must contain a regular auth.json');
  const repetitions = boundedInteger(options.repetitions ?? '1', 1, 3, 'repetitions');
  const timeoutMinutes = boundedInteger(
    options['timeout-minutes'] ?? '60',
    1,
    90,
    'timeout-minutes',
  );
  const agentTimeoutSeconds = boundedInteger(
    options['agent-timeout-seconds'] ?? '300',
    1,
    600,
    'agent-timeout-seconds',
  );
  const cases = (options.cases ?? 'defects,clean').split(',');
  const selectedModes = (
    options.modes ?? (options['require-auth-refresh'] ? 'parallel,serial' : 'serial,parallel')
  ).split(',');
  if (
    selectedModes.length === 0 ||
    new Set(selectedModes).size !== selectedModes.length ||
    selectedModes.some((mode) => !['serial', 'parallel'].includes(mode))
  )
    throw new Error('--modes must be serial, parallel or serial,parallel');
  if (
    cases.length === 0 ||
    new Set(cases).size !== cases.length ||
    cases.some((value) => !['defects', 'clean'].includes(value))
  )
    throw new Error('--cases must be defects, clean or defects,clean');
  if (repetitions * cases.length * 4 * 3 > 72)
    throw new Error('Benchmark exceeds the 72-Agent-run bound');
  const executable = options.codex ?? 'codex';
  const version = (await exec(executable, ['--version'], { timeout: 10_000 })).stdout.trim();
  if (version !== 'codex-cli 0.162.0')
    throw new Error('Live benchmarks require the exact deployed Codex 0.162.0');
  const [
    { CloneManager },
    { CodexAppServerRunner },
    { loadAgentDefinitions },
    { parseFindingsPayload },
    { synthesizeAgentOutputs },
    { agentRunFailure },
  ] = await Promise.all([
    import(join(worker, 'git/clone-manager.js')),
    import(join(worker, 'worker/codex-app-server-runner.js')),
    import(join(worker, 'config/agents.js')),
    import(join(worker, 'worker/findings-parser.js')),
    import(join(worker, 'synthesizer/synthesizer.js')),
    import(join(worker, 'worker/review-errors.js')),
  ]);
  const definitions = await loadAgentDefinitions(join(sandyRoot, 'agents'));
  const agents = ['logic', 'security'].map((key) => {
    const agent = definitions.get(key);
    if (!agent) throw new Error(`Missing fixed Agent ${key}`);
    return agent;
  });
  agents.push({
    key: 'framework',
    name: 'Zod fixture framework reviewer',
    description: 'Review installed-version validation and serialized response behavior',
    category: 'framework',
    vendor: 'codex',
    model: agents[0].model,
    effort: agents[0].effort,
    completionSignal: '</findings>',
    defaultEnabled: true,
    systemPrompt:
      'Review this change for correctness of Zod validation and response serialization. Follow the installed-version source verification contract, cite the exact source behavior before reporting a framework Finding, and inspect callers for exposure of confidential fields. Treat clean behavior as clean.',
  });
  const outputPath = resolve(options.out);
  const journal = `${outputPath}.jsonl`;
  const fixtureEvidence = `${outputPath}.fixtures`;
  await mkdir(dirname(outputPath), { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-live-benchmark-')));
  const snapshots = join(root, 'download-snapshots');
  const samples = [];
  const priming = [];
  let nativePreflight;
  const runId = randomUUID();
  let refreshProbe;
  let authRefreshObserved = null;
  const termination = new AbortController();
  const abortOnTermination = () =>
    termination.abort(new Error('Benchmark terminated; draining runtime'));
  process.on('SIGTERM', abortOnTermination);
  process.on('SIGINT', abortOnTermination);
  const signal = AbortSignal.any([
    termination.signal,
    AbortSignal.timeout(timeoutMinutes * 60_000),
  ]);
  let suite;
  let runtime;
  let safeToRemove = true;
  const logger = { info() {} }; // Results contain metrics/Findings, never unbounded runtime transcripts.
  try {
    suite = await prepareBenchmarkFixtures(root);
    const fixtures = suite.fixtures.filter((fixture) => cases.includes(fixture.id));
    const identities = new Map(
      fixtures.flatMap((fixture) => [
        [fixture.repo.name, fixture.origin],
        [fixture.sibling.repo.name, fixture.sibling.origin],
      ]),
    );
    const cloneManager = new CloneManager({
      baseDir: join(root, 'clones'),
      cloneUrl: (repo) => identities.get(repo.name),
      signal,
    });
    const fixed = {
      codexVersion: version,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      agents,
      testMode: 'targeted',
      maximumConcurrency: 3,
      modes: selectedModes,
      repetitions,
      fixtures: fixtures.map(({ origin, sibling, ...fixture }) => ({
        ...fixture,
        sibling: { repo: sibling.repo, sha: sibling.sha },
      })),
      downloadMeasurement: suite.source,
      modelTurnUpperBound:
        repetitions * cases.length * selectedModes.length * 2 * agents.length * 2,
    };
    await writeFile(journal, `${JSON.stringify({ configuration: fixed })}\n`, { flag: 'wx' });
    process.stderr.write(
      `Sandy benchmark: first repetition mode order ${selectedModes.join(',')}.\n`,
    );
    await suite.persistEvidence(fixtureEvidence);
    for (const fixture of fixtures) {
      await cloneManager.ensureCloned(fixture.repo);
      await cloneManager.ensureCloned(fixture.sibling.repo);
      const sibling = await cloneManager.createWorktree(fixture.sibling.repo, {
        reviewJobId: `benchmark-sibling-${fixture.id}`,
        sha: fixture.sibling.sha,
      });
      const siblingWorktrees = [
        { repo: 'evaluation/consumer', sha: sibling.sha, hostPath: sibling.path },
      ];
      const backing = new Map();
      const installerHome = join(root, 'installer-home');
      const protectedPaths = [
        outputPath,
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
        ...(process.env.RUNNER_TEMP
          ? [join(process.env.RUNNER_TEMP, '_runner_file_commands')]
          : []),
        ...[
          'GITHUB_ENV',
          'GITHUB_OUTPUT',
          'GITHUB_PATH',
          'GITHUB_STEP_SUMMARY',
          'GITHUB_STATE',
        ].flatMap((key) => (process.env[key] ? [resolve(process.env[key])] : [])),
      ];
      const makeRunner = (cache) =>
        new CodexAppServerRunner({
          codexHome,
          toolHome: installerHome,
          executable,
          enableManagedRuntime: true,
          testMode: 'targeted',
          agentTimeoutMs: agentTimeoutSeconds * 1000,
          installTimeoutMs: 120_000,
          protectedPaths,
          logger,
          dependencyDownloadCache: cache,
        });
      const cache = (restore, publish) => ({
        async restore({ key, storePath }) {
          const saved = backing.get(key);
          if (!restore || !saved) return undefined;
          await cp(saved, storePath, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
          return key;
        },
        async save({ key, storePath }) {
          if (!publish) return;
          await mkdir(snapshots, { recursive: true });
          const path = join(snapshots, createHash('sha256').update(key).digest('hex'));
          await rm(path, { recursive: true, force: true });
          await cp(storePath, path, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
          backing.set(key, path);
        },
      });
      const prime = await cloneManager.createWorktree(fixture.repo, {
        reviewJobId: `benchmark-prime-${fixture.id}`,
        sha: fixture.headSha,
      });
      suite.resetDownloads();
      const primeStart = Date.now();
      const primeResult = await makeRunner(cache(false, true)).installDependencies({
        worktreePath: prime.path,
        cacheKey: 'evaluation/producer',
        signal,
      });
      const failure =
        primeResult.status !== 'installed' || backing.size === 0
          ? preparationFailure(primeResult)
          : undefined;
      const primed = {
        fixtureId: fixture.id,
        elapsedMs: Date.now() - primeStart,
        status: primeResult.status,
        downloads: suite.downloads(),
        cache: primeResult.cache ?? null,
        ...(failure ? { failure } : {}),
      };
      priming.push(primed);
      await appendFile(journal, `${JSON.stringify({ priming: primed })}\n`);
      await cloneManager.removeWorktree(prime);
      if (failure)
        throw new Error(`Controlled warm-cache priming failed: ${failure.stage} (${failure.code})`);
      if (nativePreflight === undefined) {
        process.stderr.write('Sandy benchmark: validating anonymous native managed adapter.\n');
        try {
          nativePreflight = await runManagedRuntimeProbe(executable);
          await appendFile(journal, `${JSON.stringify({ nativePreflight })}\n`);
        } catch (error) {
          await appendFile(
            journal,
            `${JSON.stringify({ nativePreflight: { status: 'failed', failure: agentRunFailure(error) } })}\n`,
          );
          throw new Error('Native managed adapter preflight failed before live model evaluation');
        }
      }
      const configurationDigest = createHash('sha256')
        .update(
          JSON.stringify({
            codexVersion: version,
            node: fixed.node,
            platform: fixed.platform,
            architecture: fixed.architecture,
            agents,
            testMode: fixed.testMode,
            maximumConcurrency: fixed.maximumConcurrency,
            agentTimeoutSeconds,
            fixture: {
              head: fixture.headSha,
              base: fixture.baseSha,
              sibling: fixture.sibling.sha,
              packageManager: fixture.packageManager,
              manifest: fixture.manifest,
            },
          }),
        )
        .digest('hex');
      for (let repetition = 0; repetition < repetitions; repetition++) {
        // Alternate mode ordering to reduce systematic order bias.
        const modes = repetition % 2 === 0 ? selectedModes : [...selectedModes].reverse();
        for (const cacheState of ['cold', 'warm'])
          for (const mode of modes) {
            signal.throwIfAborted();
            const id = `${runId}-${fixture.id}-${repetition}-${cacheState}-${mode}`;
            const cell = `${fixture.id}/${cacheState}/${mode}/repetition-${repetition + 1}`;
            process.stderr.write(`Sandy benchmark ${cell}: preparing.\n`);
            const start = Date.now();
            const seed = await cloneManager.createWorktree(fixture.repo, {
              reviewJobId: `benchmark-${id}`,
              sha: fixture.headSha,
            });
            const preparation = Date.now() - start;
            const runner = makeRunner(cache(cacheState === 'warm', false));
            suite.resetDownloads();
            const installStart = Date.now();
            const dependencyInstall = await runner.installDependencies({
              worktreePath: seed.path,
              cacheKey: 'evaluation/producer',
              signal,
            });
            const installation = Date.now() - installStart;
            const downloads = suite.downloads();
            if (dependencyInstall.status !== 'installed')
              throw new Error(
                'Fixture installation failed; no valid matched benchmark can be reported',
              );
            process.stderr.write(`Sandy benchmark ${cell}: preparation complete.\n`);
            const seedDisk = await measureTree(seed.path);
            const materializationStart = Date.now();
            const privateWorkspaces = [];
            for (const agent of agents)
              privateWorkspaces.push(await cloneManager.materializeAgentWorkspace(seed, agent.key));
            const materialization = Date.now() - materializationStart;
            const disk = {
              logicalBytes: 0,
              allocatedBytes: 0,
              seedLogicalBytes: seedDisk.logicalBytes,
              seedAllocatedBytes: seedDisk.allocatedBytes,
            };
            for (const workspace of privateWorkspaces) {
              const measured = await measureTree(workspace.path);
              disk.logicalBytes += measured.logicalBytes;
              disk.allocatedBytes += measured.allocatedBytes;
            }
            const startup = Date.now();
            if (
              mode === 'parallel' &&
              options['require-auth-refresh'] &&
              refreshProbe === undefined
            ) {
              const { observeDedicatedAuthRefresh } = await import(
                join(worker, 'benchmark/auth-refresh-evidence.js')
              );
              refreshProbe = await observeDedicatedAuthRefresh(codexHome);
            }
            runtime = await runner.openReview({
              worktreePath: seed.path,
              siblingWorktrees,
              privateWorkspacePaths: privateWorkspaces.map((workspace) => workspace.path),
              maxConcurrency: mode === 'serial' ? 1 : 3,
              signal,
            });
            safeToRemove = false;
            if (runtime.mode !== mode)
              throw new Error(
                'Requested parallel runtime fell back; benchmark will retain completed samples without inventing parallel measurements',
              );
            if (mode === 'parallel' && refreshProbe !== undefined && authRefreshObserved === null) {
              if (!runtime.refreshAuthentication)
                throw new Error('Required native authentication refresh operation unavailable');
              try {
                await runtime.refreshAuthentication();
                authRefreshObserved = await refreshProbe.refreshObserved();
                await appendFile(journal, `${JSON.stringify({ authRefreshObserved })}\n`);
                if (!authRefreshObserved)
                  throw new Error(
                    'Native authentication refresh did not persist same-account rotation',
                  );
              } catch (error) {
                await appendFile(
                  journal,
                  `${JSON.stringify({ authentication: { stage: 'native-refresh', status: 'failed', failure: agentRunFailure(error) } })}\n`,
                );
                throw new Error(
                  'Required native authentication refresh failed before Agent admission',
                );
              }
            }
            const runtimeStartup = Date.now() - startup;
            const investigation = Date.now();
            process.stderr.write(`Sandy benchmark ${cell}: investigating.\n`);
            let next = 0;
            const outcomes = new Array(agents.length);
            const agentOutputs = new Array(agents.length);
            await Promise.all(
              Array.from({ length: runtime.maxConcurrency }, async () => {
                for (;;) {
                  const index = next++;
                  if (index >= agents.length) return;
                  const agent = agents[index];
                  const startedAt = Date.now();
                  let result;
                  try {
                    signal.throwIfAborted();
                    runtime.failureSignal?.throwIfAborted();
                    result = await runtime.runAgent({
                      agent,
                      worktreePath: privateWorkspaces[index].path,
                      pullRequest: {
                        owner: 'evaluation',
                        repo: 'producer',
                        number: 1,
                        headSha: fixture.headSha,
                        baseRef: 'baseline',
                        title: 'Pinned evaluation change',
                        url: 'https://github.com/evaluation/producer/pull/1',
                      },
                      siblingWorktrees,
                      apiSurfaceManifest: fixture.manifest,
                      dependencyInstall,
                      signal: AbortSignal.any([
                        signal,
                        AbortSignal.timeout(agentTimeoutSeconds * 1000),
                      ]),
                    });
                    const payload = parseFindingsPayload(result.stdout);
                    if (payload.findings.length > 100)
                      throw new Error('Fixture finding count exceeded bound');
                    const findings = payload.findings.map((finding) => ({
                      ...finding,
                      agentKey: agent.key,
                    }));
                    agentOutputs[index] = {
                      agentKey: agent.key,
                      payload: { ...payload, findings },
                    };
                    outcomes[index] = {
                      agentKey: agent.key,
                      status: 'completed',
                      startedAt,
                      finishedAt: Date.now(),
                      queueWaitMs: startedAt - investigation,
                      usage: result.usage ?? null,
                      activity: result.activity ?? null,
                      findings,
                    };
                  } catch (error) {
                    outcomes[index] = {
                      agentKey: agent.key,
                      status: 'failed',
                      startedAt,
                      finishedAt: Date.now(),
                      queueWaitMs: startedAt - investigation,
                      usage: result?.usage ?? error.usage ?? null,
                      activity: result?.activity ?? null,
                      findings: [],
                      failure: agentRunFailure(error),
                    };
                  }
                }
              }),
            );
            const agentMs = Date.now() - investigation;
            const shutdownStart = Date.now();
            await runtime.close();
            runtime = undefined;
            safeToRemove = true;
            const shutdown = Date.now() - shutdownStart;
            const synthesisStart = Date.now();
            const numstat = (
              await exec('git', [
                '-C',
                seed.path,
                'diff',
                '--numstat',
                `${fixture.baseSha}...${fixture.headSha}`,
              ])
            ).stdout;
            const changedLineCount = numstat.split('\n').reduce(
              (sum, line) =>
                sum +
                line
                  .split('\t')
                  .slice(0, 2)
                  .reduce((count, value) => count + (Number.parseInt(value, 10) || 0), 0),
              0,
            );
            const synthesized = synthesizeAgentOutputs({
              agentOutputs: agentOutputs.filter(Boolean),
              changedLineCount,
            });
            const synthesis = Date.now() - synthesisStart;
            const successes = outcomes.filter((outcome) => outcome.status === 'completed').length;
            const sample = {
              id,
              source: 'codex-runtime',
              fixtureId: fixture.id,
              configurationDigest,
              cache: cacheState,
              mode,
              repetition,
              elapsedMs: Date.now() - start,
              phases: {
                preparation,
                installation,
                materialization,
                runtimeStartup,
                agents: agentMs,
                shutdown,
                synthesis,
                posting: null,
                cacheRestore: dependencyInstall.cache?.restoreMs ?? null,
                cacheSave: dependencyInstall.cache?.saveMs ?? null,
              },
              cacheResult: dependencyInstall.cache ?? null,
              downloads,
              disk,
              selectedAgentKeys: agents.map((agent) => agent.key),
              agents: outcomes,
              outcome:
                successes === agents.length ? 'completed' : successes === 0 ? 'failed' : 'partial',
              synthesis: {
                findings: synthesized.findings.length,
                rawFindingCount: synthesized.rawFindingCount,
                confidenceScore: synthesized.confidenceScore,
              },
            };
            samples.push(sample);
            await appendFile(journal, `${JSON.stringify({ sample })}\n`);
            await writeFile(
              outputPath,
              `${JSON.stringify({ configuration: fixed, priming, nativePreflight, fixtures, samples, authRefreshObserved }, null, 2)}\n`,
            );
            console.info(
              JSON.stringify({ sample: id, outcome: sample.outcome, elapsedMs: sample.elapsedMs }),
            );
            for (const workspace of privateWorkspaces) await cloneManager.removeWorktree(workspace);
            await cloneManager.removeWorktree(seed);
            if (options['require-auth-refresh'] && authRefreshObserved === false)
              throw new Error('Required dedicated test authentication refresh was not observed');
          }
      }
      await cloneManager.removeWorktree(sibling);
    }
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.close();
        safeToRemove = true;
      } catch {
        safeToRemove = false;
      }
    }
    await suite?.close();
    if (safeToRemove) await rm(root, { recursive: true, force: true });
    else
      console.error(
        'Runtime teardown failed; disposable workspace roots retained until quiescence is confirmed',
      );
    process.off('SIGTERM', abortOnTermination);
    process.off('SIGINT', abortOnTermination);
  }
}

/** Persist only fixed classifications; reviewed command output never enters live logs. */
function preparationFailure(result) {
  if (result.status === 'installed')
    return { stage: 'download-publication', code: 'NO_SAFE_SNAPSHOT' };
  if (result.status === 'skipped') return { stage: 'installation', code: 'SKIPPED' };
  const output = String(result.error);
  const code =
    /\b(EROFS|EACCES|EPERM|EINTEGRITY|ECONNREFUSED|ETIMEDOUT)\b/.exec(output)?.[1] ??
    (output.includes('Read-only file system') ? 'EROFS' : 'UNKNOWN');
  return { stage: output.startsWith('bwrap:') ? 'sandbox-startup' : 'installation', code };
}

async function measureTree(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return { logicalBytes: 0, allocatedBytes: 0 };
  if (!metadata.isDirectory())
    return { logicalBytes: metadata.size, allocatedBytes: metadata.blocks * 512 };
  const total = { logicalBytes: 0, allocatedBytes: metadata.blocks * 512 };
  for (const name of await readdir(path)) {
    const child = await measureTree(join(path, name));
    total.logicalBytes += child.logicalBytes;
    total.allocatedBytes += child.allocatedBytes;
  }
  return total;
}

function boundedInteger(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return number;
}

const [command, ...arguments_] = process.argv.slice(2);
const options = {};
for (let index = 0; index < arguments_.length; index++) {
  const key = arguments_[index];
  if (key === '--require-auth-refresh') {
    options['require-auth-refresh'] = true;
    continue;
  }
  const value = arguments_[++index];
  if (!key?.startsWith('--') || value === undefined)
    throw new Error('Expected --option value pairs');
  if (key === '--samples') {
    options.samples ??= [];
    options.samples.push(value);
    continue;
  }
  if (Object.hasOwn(options, key.slice(2))) throw new Error('Expected unique --option value pairs');
  options[key.slice(2)] = value;
}
if (command === 'run') await liveBenchmark(options);
else if (command === 'report') {
  if (!options.samples || !options.adjudication || !options.out)
    throw new Error('report requires --samples, --adjudication and --out');
  const { buildBenchmarkReport, combineBenchmarkCaptures } = await import(
    join(worker, 'benchmark/review-benchmark.js')
  );
  const captures = await Promise.all(
    options.samples.map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
  );
  const { samples, fixtures } = combineBenchmarkCaptures(captures);
  const adjudications = JSON.parse(await readFile(options.adjudication, 'utf8'));
  const operationalEvidence = options['operational-evidence']
    ? JSON.parse(await readFile(options['operational-evidence'], 'utf8'))
    : undefined;
  const report = buildBenchmarkReport({
    samples,
    fixtures,
    adjudications,
    operationalEvidence,
  });
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
  console.info(
    JSON.stringify({
      sampleCount: report.sampleCount,
      promotionReady: report.promotionReady,
      pendingGates: report.pendingGates,
    }),
  );
} else
  throw new Error(
    'Use run with explicit --ci-home, or report for offline adjudicated measurements',
  );
