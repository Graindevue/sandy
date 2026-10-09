import type { AgentRunUsage, Finding, Severity } from '@sandy/shared-types';

export interface BenchmarkSample {
  id: string;
  source: 'codex-runtime' | 'synthetic-test';
  fixtureId: string;
  configurationDigest: string;
  cache: 'cold' | 'warm';
  mode: 'serial' | 'parallel';
  repetition: number;
  elapsedMs: number;
  phases: Record<string, number | null>;
  downloads: { requests: number | null; bytes: number | null };
  disk: {
    logicalBytes: number;
    allocatedBytes: number;
    seedLogicalBytes?: number;
    seedAllocatedBytes?: number;
  };
  selectedAgentKeys: string[];
  outcome: 'completed' | 'partial' | 'failed';
  agents: {
    agentKey: string;
    status: 'completed' | 'failed';
    startedAt: number;
    finishedAt: number;
    usage: AgentRunUsage | null;
    activity: { toolCount: number; toolDurationMs?: number } | null;
    findings: Finding[];
  }[];
}

export interface BenchmarkFixture {
  id: string;
  scenarios?: ('incomplete-tests' | 'source-verification')[];
  expected: {
    id: string;
    severity: Severity;
    kind: 'logic' | 'security' | 'framework' | 'cross-repo' | 'coverage';
  }[];
}

/** Human judgments, separate from the model's self-reported confidence or labels. */
export interface BenchmarkAdjudication {
  sampleId: string;
  reviewer: string;
  findings: {
    agentKey: string;
    findingIndex: number;
    defectId: string | null;
    actionableFalsePositive: boolean;
    correctSeverity: boolean;
    correctProducer: boolean;
    verifiedInstalledSource: boolean;
  }[];
}

/** Keep smoke-run sample identities stable while assigning aggregate repetitions. */
export function combineBenchmarkCaptures(
  captures: { samples: BenchmarkSample[]; fixtures: BenchmarkFixture[] }[],
) {
  const samples: BenchmarkSample[] = [];
  const fixtures = new Map<string, BenchmarkFixture>();
  let offset = 0;
  for (const capture of captures) {
    const repetitions = [...new Set(capture.samples.map((sample) => sample.repetition))].toSorted(
      (left, right) => left - right,
    );
    for (const sample of capture.samples)
      samples.push({ ...sample, repetition: offset + repetitions.indexOf(sample.repetition) });
    offset += repetitions.length;
    for (const fixture of capture.fixtures) {
      const previous = fixtures.get(fixture.id);
      if (
        previous &&
        JSON.stringify({ scenarios: previous.scenarios, expected: previous.expected }) !==
          JSON.stringify({ scenarios: fixture.scenarios, expected: fixture.expected })
      )
        throw new Error('Fixture adjudication changed between captures');
      fixtures.set(fixture.id, fixture);
    }
  }
  return { samples, fixtures: [...fixtures.values()] };
}

function statistics(values: number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  for (const value of sorted)
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid benchmark measurement');
  const midpoint = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    medianMs:
      sorted.length === 0
        ? null
        : sorted.length % 2 === 0
          ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
          : (sorted[midpoint] ?? null),
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  };
}

/** Summarize actual runs without substituting mock output or unknown metrics. */
export function buildBenchmarkReport(input: {
  samples: BenchmarkSample[];
  fixtures: BenchmarkFixture[];
  adjudications: BenchmarkAdjudication[];
  operationalEvidence?: {
    linuxCompatibility: boolean;
    dedicatedAuthRefreshWriteback: boolean;
    failureSemantics: boolean;
  };
}) {
  const { samples, fixtures, adjudications } = input;
  const pendingGates: string[] = [];
  const evidenceKind =
    samples.length > 0 && samples.every((sample) => sample.source === 'codex-runtime')
      ? 'codex-runtime'
      : 'synthetic-test';
  if (evidenceKind !== 'codex-runtime') pendingGates.push('live model measurements');
  const expected = fixtures.flatMap((fixture) => fixture.expected);
  const evaluationCoverage =
    ['logic', 'security', 'framework', 'cross-repo'].every((kind) =>
      expected.some((defect) => defect.kind === kind),
    ) &&
    ['P0', 'P1'].every((severity) => expected.some((defect) => defect.severity === severity)) &&
    fixtures.some((fixture) => fixture.expected.length === 0) &&
    ['incomplete-tests', 'source-verification'].every((scenario) =>
      fixtures.some((fixture) => fixture.scenarios?.some((value) => value === scenario)),
    );
  if (!evaluationCoverage) pendingGates.push('adjudicated evaluation coverage');
  const latency = Object.fromEntries(
    (['cold', 'warm'] as const).map((cache) => {
      const serial = statistics(
        samples
          .filter((sample) => sample.cache === cache && sample.mode === 'serial')
          .map((sample) => sample.elapsedMs),
      );
      const parallel = statistics(
        samples
          .filter((sample) => sample.cache === cache && sample.mode === 'parallel')
          .map((sample) => sample.elapsedMs),
      );
      const difference =
        serial.medianMs === null || parallel.medianMs === null
          ? null
          : parallel.medianMs - serial.medianMs;
      return [
        cache,
        {
          serial,
          parallel,
          medianDifferenceMs: difference,
          medianDifferencePercent:
            difference === null || !serial.medianMs ? null : (difference / serial.medianMs) * 100,
        },
      ];
    }),
  ) as Record<
    'cold' | 'warm',
    {
      serial: ReturnType<typeof statistics>;
      parallel: ReturnType<typeof statistics>;
      medianDifferenceMs: number | null;
      medianDifferencePercent: number | null;
    }
  >;
  const keys = new Set<string>();
  const digests = new Map<string, string>();
  for (const sample of samples) {
    if (keys.has(sample.id)) throw new Error('Duplicate benchmark sample');
    keys.add(sample.id);
    if (!fixtures.some((fixture) => fixture.id === sample.fixtureId))
      throw new Error('Unknown benchmark fixture');
    const digest = digests.get(sample.fixtureId);
    if (digest !== undefined && digest !== sample.configurationDigest)
      throw new Error('Matched benchmark configuration changed');
    digests.set(sample.fixtureId, sample.configurationDigest);
  }
  const repetitions = [...new Set(samples.map((sample) => sample.repetition))];
  const matched =
    fixtures.length > 0 &&
    repetitions.length >= 3 &&
    fixtures.every((fixture) =>
      repetitions.every((repetition) =>
        ['cold', 'warm'].every((cache) =>
          ['serial', 'parallel'].every(
            (mode) =>
              samples.filter(
                (sample) =>
                  sample.fixtureId === fixture.id &&
                  sample.repetition === repetition &&
                  sample.cache === cache &&
                  sample.mode === mode,
              ).length === 1,
          ),
        ),
      ),
    );
  if (!matched) pendingGates.push('at least three complete matched repetitions');
  const allSelectedAgents = samples.every(
    (sample) =>
      sample.selectedAgentKeys.length > 0 &&
      sample.agents.length === sample.selectedAgentKeys.length &&
      sample.selectedAgentKeys.every(
        (key) => sample.agents.filter((agent) => agent.agentKey === key).length === 1,
      ),
  );
  const partialFailureReporting = samples.every(
    (sample) =>
      sample.agents.every((agent) => agent.status === 'completed') ||
      sample.outcome !== 'completed',
  );
  const completeAdjudication =
    samples.length > 0 &&
    samples.every((sample) => {
      const judgments = adjudications.filter((judgment) => judgment.sampleId === sample.id);
      return (
        judgments.length === 1 &&
        (judgments[0]?.reviewer.trim().length ?? 0) > 0 &&
        judgments[0]?.findings.length ===
          sample.agents.reduce((sum, agent) => sum + agent.findings.length, 0) &&
        sample.agents.every((agent) =>
          agent.findings.every(
            (_, findingIndex) =>
              judgments[0]?.findings.filter(
                (judgment) =>
                  judgment.agentKey === agent.agentKey && judgment.findingIndex === findingIndex,
              ).length === 1,
          ),
        )
      );
    });
  if (!completeAdjudication) pendingGates.push('human adjudication');
  const scores = {
    serial: { expected: 0, found: 0, falsePositives: 0, failures: 0 },
    parallel: { expected: 0, found: 0, falsePositives: 0, failures: 0 },
  };
  const bySeverity = Object.fromEntries(
    ['P0', 'P1', 'P2'].map((severity) => [
      severity,
      { serial: { expected: 0, found: 0 }, parallel: { expected: 0, found: 0 } },
    ]),
  ) as Record<
    Severity,
    { serial: { expected: number; found: number }; parallel: { expected: number; found: number } }
  >;
  let noMissedCritical = true;
  let correctProducer = true;
  let installedSourceVerified = true;
  let correctSeverity = true;
  for (const sample of samples) {
    const fixture = fixtures.find((fixture) => fixture.id === sample.fixtureId);
    const judgments = (
      adjudications.find((judgment) => judgment.sampleId === sample.id)?.findings ?? []
    ).map((judgment) => {
      const agent = sample.agents.find((agent) => agent.agentKey === judgment.agentKey);
      const finding = agent?.findings[judgment.findingIndex];
      const defect = fixture?.expected.find((defect) => defect.id === judgment.defectId);
      return {
        ...judgment,
        correctProducer:
          finding !== undefined && judgment.correctProducer && finding.agentKey === agent?.agentKey,
        correctSeverity:
          finding !== undefined &&
          judgment.correctSeverity &&
          (defect === undefined || finding.severity === defect.severity),
      };
    });
    const score = scores[sample.mode];
    score.expected += fixture?.expected.length ?? 0;
    score.failures += sample.agents.filter((agent) => agent.status !== 'completed').length;
    for (const judgment of judgments) {
      if (
        judgment.defectId !== null &&
        !fixture?.expected.some((defect) => defect.id === judgment.defectId)
      )
        throw new Error('Adjudication references an unknown expected defect');
      if (judgment.actionableFalsePositive) score.falsePositives++;
      correctProducer &&= judgment.correctProducer;
      correctSeverity &&= judgment.correctSeverity;
    }
    for (const defect of fixture?.expected ?? []) {
      const matches = judgments.filter(
        (judgment) =>
          judgment.defectId === defect.id && judgment.correctProducer && judgment.correctSeverity,
      );
      const found = matches.length > 0;
      if (found) score.found++;
      bySeverity[defect.severity][sample.mode].expected++;
      if (found) bySeverity[defect.severity][sample.mode].found++;
      if (sample.mode === 'parallel' && defect.severity !== 'P2' && !found)
        noMissedCritical = false;
      if (defect.kind === 'framework' && matches.some((match) => !match.verifiedInstalledSource))
        installedSourceVerified = false;
    }
  }
  const recall = (score: { expected: number; found: number }) =>
    score.expected === 0 ? 1 : score.found / score.expected;
  const quality = {
    adjudicated: completeAdjudication,
    byMode: scores,
    bySeverity,
    gates: {
      noMissedCritical,
      noRecallRegression: recall(scores.parallel) >= recall(scores.serial),
      noFalsePositiveIncrease: scores.parallel.falsePositives <= scores.serial.falsePositives,
      noFailureIncrease: scores.parallel.failures <= scores.serial.failures,
      allSelectedAgents,
      correctProducer,
      correctSeverity,
      installedSourceVerified,
      partialFailureReporting,
    },
  };
  const metrics = samples.map((sample) => ({
    sampleId: sample.id,
    phases: sample.phases,
    downloads: sample.downloads,
    disk: sample.disk,
    tools: sample.agents.some((agent) => agent.activity === null)
      ? null
      : {
          count: sample.agents.reduce((sum, agent) => sum + (agent.activity?.toolCount ?? 0), 0),
          durationMs: sample.agents.some((agent) => agent.activity?.toolDurationMs === undefined)
            ? null
            : sample.agents.reduce((sum, agent) => sum + (agent.activity?.toolDurationMs ?? 0), 0),
        },
    usage: sample.agents.some((agent) => agent.usage === null)
      ? null
      : sample.agents.reduce<AgentRunUsage>(
          (total, agent) => ({
            inputTokens: total.inputTokens + (agent.usage?.inputTokens ?? 0),
            cacheReadInputTokens:
              total.cacheReadInputTokens + (agent.usage?.cacheReadInputTokens ?? 0),
            cacheCreationInputTokens:
              total.cacheCreationInputTokens + (agent.usage?.cacheCreationInputTokens ?? 0),
            outputTokens: total.outputTokens + (agent.usage?.outputTokens ?? 0),
          }),
          { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 },
        ),
    agents: sample.agents.map(({ findings, ...agent }) => ({
      ...agent,
      findingCount: findings.length,
    })),
  }));
  const phaseNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.phases)))];
  const phaseStatistics = (cache: BenchmarkSample['cache'], mode: BenchmarkSample['mode']) =>
    Object.fromEntries(
      phaseNames.map((name) => [
        name,
        statistics(
          samples
            .filter((sample) => sample.cache === cache && sample.mode === mode)
            .flatMap((sample) =>
              typeof sample.phases[name] === 'number' ? [sample.phases[name]] : [],
            ),
        ),
      ]),
    );
  const phases = {
    cold: {
      serial: phaseStatistics('cold', 'serial'),
      parallel: phaseStatistics('cold', 'parallel'),
    },
    warm: {
      serial: phaseStatistics('warm', 'serial'),
      parallel: phaseStatistics('warm', 'parallel'),
    },
  };
  const improvedLatency =
    latency.cold.medianDifferenceMs !== null &&
    latency.cold.medianDifferenceMs < 0 &&
    latency.warm.medianDifferenceMs !== null &&
    latency.warm.medianDifferenceMs < 0;
  if (!improvedLatency) pendingGates.push('lower measured cold and warm median latency');
  for (const gate of [
    'linuxCompatibility',
    'dedicatedAuthRefreshWriteback',
    'failureSemantics',
  ] as const)
    if (input.operationalEvidence?.[gate] !== true) pendingGates.push(gate);
  return {
    sampleCount: samples.length,
    matched,
    latency,
    phases,
    quality,
    metrics,
    pendingGates,
    promotionReady:
      pendingGates.length === 0 &&
      completeAdjudication &&
      Object.values(quality.gates).every(Boolean),
    evidenceKind,
    diskAccounting: 'file lengths and allocated blocks; copy-on-write blocks may be shared',
  };
}
