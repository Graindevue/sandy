import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type BenchmarkSample,
  buildBenchmarkReport,
  combineBenchmarkCaptures,
} from './review-benchmark.js';

describe('buildBenchmarkReport', () => {
  it('reports matched latency with real sample counts, medians, tails and absolute differences', () => {
    const samples = matchedSamples();
    const report = buildBenchmarkReport({
      samples,
      fixtures: [{ id: 'fixture', expected: [] }],
      adjudications: [],
    });

    expect(report.latency.cold).toEqual({
      serial: { count: 3, medianMs: 300, p95Ms: 400 },
      parallel: { count: 3, medianMs: 150, p95Ms: 200 },
      medianDifferenceMs: -150,
      medianDifferencePercent: -50,
    });
    expect(report.latency.warm.medianDifferenceMs).toBe(-60);
    expect(report.promotionReady).toBe(false);
    expect(report.pendingGates).toContain('human adjudication');
  });

  it('keeps simulated report fixtures out of live promotion evidence', () => {
    const report = buildBenchmarkReport({
      samples: matchedSamples(),
      fixtures: [{ id: 'fixture', expected: [] }],
      adjudications: [],
    });
    expect(report.evidenceKind).toBe('synthetic-test');
    expect(report.pendingGates).toContain('live model measurements');
  });

  it('requires defects, clean changes and source/coverage cases before promotion', () => {
    const report = buildBenchmarkReport({
      samples: matchedSamples(),
      fixtures: [{ id: 'fixture', expected: [] }],
      adjudications: [],
    });
    expect(report.pendingGates).toContain('adjudicated evaluation coverage');
  });

  it('refuses live benchmark execution without an explicit dedicated CI home', async () => {
    await expect(
      promisify(execFile)(
        process.execPath,
        ['scripts/review-benchmark.mjs', 'run', '--out', '/tmp/unrequested-live-benchmark.json'],
        { env: { PATH: process.env.PATH, CODEX_HOME: '/tmp/implicit-auth-must-not-be-used' } },
      ),
    ).rejects.toThrow('Explicit --ci-home is required');
  });

  describe('shipped preparation CLI', () => {
    beforeAll(async () => {
      await promisify(execFile)(
        'pnpm',
        [
          '--filter',
          '@sandy/shared-types',
          '--filter',
          '@sandy/manifest-builder',
          '--filter',
          '@sandy/bot-worker',
          'build',
          '--incremental',
          'false',
        ],
        { timeout: 60_000, maxBuffer: 64_000 },
      );
    }, 65_000);

    it('retains scoped priming failure evidence without raw preparation logs or model execution', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sandy-benchmark-primer-test-'));
      try {
        const home = join(root, 'auth');
        await mkdir(home);
        await writeFile(join(home, 'auth.json'), '{}');
        const executable = join(root, 'codex');
        await writeFile(
          executable,
          `#!/usr/bin/env node
        if (process.argv[2] === '--version') { console.log('codex-cli 0.162.0'); process.exit(0); }
        if (process.argv[2] !== 'sandbox') throw new Error('Model runtime must not start');
        process.stderr.write('bwrap: Read-only file system SENSITIVE_DIAGNOSTIC_SENTINEL');
        process.exit(1);
      `,
        );
        await chmod(executable, 0o755);
        const output = join(root, 'results.json');
        await expect(
          promisify(execFile)(
            process.execPath,
            [
              'scripts/review-benchmark.mjs',
              'run',
              '--ci-home',
              home,
              '--codex',
              executable,
              '--out',
              output,
              '--cases',
              'defects',
              '--timeout-minutes',
              '1',
            ],
            { env: { PATH: process.env.PATH, HOME: root }, timeout: 20_000 },
          ),
        ).rejects.toThrow('Controlled warm-cache priming failed');
        const journal = await readFile(`${output}.jsonl`, 'utf8');
        expect(journal).not.toContain('SENSITIVE_DIAGNOSTIC_SENTINEL');
        const records = journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(records).toContainEqual({
          priming: expect.objectContaining({
            status: 'failed',
            failure: { stage: 'sandbox-startup', code: 'EROFS' },
            downloads: { requests: 0, bytes: 0 },
          }),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 25_000);
  });

  it('keeps absent usage unknown and summarizes observed phase durations', () => {
    const report = buildBenchmarkReport({
      samples: matchedSamples(),
      fixtures: [{ id: 'fixture', expected: [] }],
      adjudications: [],
    });
    expect(report.metrics[0]?.usage).toBe(null);
    expect(report.metrics[0]?.tools).toBe(null);
    expect(report.phases.cold.serial.installation).toEqual({ count: 3, medianMs: 20, p95Ms: 20 });
  });

  it('combines separate smoke runs into matched repetitions without changing adjudication identities', () => {
    const fixtures = [{ id: 'fixture', expected: [] }];
    const captures = [0, 1, 2].map((run) => ({
      fixtures,
      samples: matchedSamples()
        .filter((sample) => sample.repetition === 0)
        .map((sample) => ({ ...sample, id: `${run}-${sample.id}` })),
    }));
    const combined = combineBenchmarkCaptures(captures);
    expect(combined.samples.map((sample) => sample.id)).toEqual(
      captures.flatMap((capture) => capture.samples.map((sample) => sample.id)),
    );
    expect(buildBenchmarkReport({ ...combined, adjudications: [] }).matched).toBe(true);
    expect(() =>
      combineBenchmarkCaptures([
        captures[0] ?? { fixtures, samples: [] },
        {
          fixtures: [
            { id: 'fixture', expected: [{ id: 'changed', severity: 'P0', kind: 'security' }] },
          ],
          samples: [],
        },
      ]),
    ).toThrow('Fixture adjudication changed');
  });

  it('cannot count a downgraded P0 as found even when a human severity flag is incorrectly true', () => {
    const sample = matchedSamples()[0];
    if (!sample) throw new Error('Missing test sample');
    const agent = sample.agents[0];
    if (!agent) throw new Error('Missing test Agent');
    sample.mode = 'parallel';
    agent.findings = [
      {
        severity: 'P2',
        confidence: 0.9,
        agentKey: 'logic',
        anchor: { repo: 'evaluation/producer', file: 'ledger.cjs', line: 1 },
        summary: 'Tenant purge',
        evidence: 'Missing authorization',
        category: 'security',
      },
    ];
    const report = buildBenchmarkReport({
      samples: [sample],
      fixtures: [{ id: 'fixture', expected: [{ id: 'purge', severity: 'P0', kind: 'security' }] }],
      adjudications: [
        {
          sampleId: sample.id,
          reviewer: 'Maintainer',
          findings: [
            {
              agentKey: 'logic',
              findingIndex: 0,
              defectId: 'purge',
              actionableFalsePositive: false,
              correctSeverity: true,
              correctProducer: true,
              verifiedInstalledSource: false,
            },
          ],
        },
      ],
    });
    expect(report.quality.gates.correctSeverity).toBe(false);
    expect(report.quality.gates.noMissedCritical).toBe(false);
    expect(report.quality.bySeverity.P0.parallel.found).toBe(0);
  });
});

function matchedSamples(): BenchmarkSample[] {
  return (['cold', 'warm'] as const).flatMap((cache) =>
    (['serial', 'parallel'] as const).flatMap((mode) =>
      (cache === 'cold' ? [200, 300, 400] : [100, 120, 140]).map((elapsedMs, repetition) => ({
        id: `${cache}-${mode}-${repetition}`,
        source: 'synthetic-test',
        fixtureId: 'fixture',
        configurationDigest: 'fixed-configuration',
        cache,
        mode,
        repetition,
        elapsedMs: elapsedMs / (mode === 'parallel' ? 2 : 1),
        phases: {
          preparation: 10,
          installation: 20,
          materialization: 5,
          runtimeStartup: 10,
          agents: 50,
          shutdown: 5,
        },
        downloads: { requests: 1, bytes: 100 },
        disk: { logicalBytes: 100, allocatedBytes: 4096 },
        agents: [
          {
            agentKey: 'logic',
            status: 'completed',
            startedAt: 10,
            finishedAt: 20,
            usage: null,
            activity: null,
            findings: [],
          },
        ],
        selectedAgentKeys: ['logic'],
        outcome: 'completed',
      })),
    ),
  );
}
