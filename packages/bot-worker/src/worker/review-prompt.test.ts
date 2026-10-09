import { describe, expect, it } from 'vitest';
import type { RunAgentInput } from './codex-exec-runner.js';
import type { DependencyInstallResult } from './dependency-install.js';
import { buildReviewPrompt } from './review-prompt.js';

type InstalledDependencies = Extract<DependencyInstallResult, { status: 'installed' }>;

const input: RunAgentInput = {
  agent: {
    key: 'logic',
    name: 'Logic',
    description: 'Find bugs',
    category: 'logic',
    vendor: 'codex',
    model: 'gpt-6.1-sol',
    completionSignal: '</findings>',
    defaultEnabled: true,
    systemPrompt: 'Find concrete logic bugs.',
  },
  worktreePath: '/review/widget',
  pullRequest: {
    owner: 'acme',
    repo: 'widget',
    number: 42,
    headSha: 'a'.repeat(40),
    baseRef: 'main',
    title: 'Fix behavior',
    url: 'https://github.com/acme/widget/pull/42',
  },
};

function installed(testStatus?: InstalledDependencies['testStatus']): InstalledDependencies {
  return {
    status: 'installed',
    packageManager: 'pnpm',
    command: 'npx --yes pnpm@12.10.1 install --frozen-lockfile',
    durationMs: 1500,
    ...(testStatus !== undefined ? { testStatus } : {}),
  };
}

describe('buildReviewPrompt', () => {
  it('defers the full suite honestly while allowing focused finding verification', () => {
    const prompt = buildReviewPrompt({
      ...input,
      dependencyInstall: {
        ...installed('deferred'),
        testResult: 'Full-suite validation is deferred to repository CI.',
      },
    });

    expect(prompt).toContain('Dependencies are installed:');
    expect(prompt).toContain('node_modules is present in the worktree.');
    expect(prompt).toContain(
      'Sandy deferred the full project test suite to repository CI; it has not run in this Review.',
    );
    expect(prompt).toContain('focused package scripts or tests only when needed');
    expect(prompt).toContain('verify a concrete candidate Finding');
    expect(prompt).toContain('Do NOT run root or whole-monorepo test suites');
    expect(prompt).toContain('Do NOT re-run a dependency install');
    expect(prompt).toContain('same package manager and exact version');
    expect(prompt).toContain('npx --yes pnpm@12.10.1 install --frozen-lockfile');
    expect(prompt).toContain('build only what the test imports, never the whole Repo.');
    expect(prompt).toContain(
      'Test-suite context:\nFull-suite validation is deferred to repository CI.',
    );
    expect(prompt).not.toContain('test suite once');
    expect(prompt).not.toContain('because no project test script is defined');
  });

  it.each([
    {
      testStatus: 'passed',
      expected: 'Sandy ran the project test suite once and it passed.',
    },
    {
      testStatus: 'failed',
      expected: 'Sandy attempted the project test suite once and it failed.',
    },
    {
      testStatus: 'skipped',
      expected:
        'Sandy did not run the project test suite because no project test script is defined.',
    },
    { testStatus: undefined, expected: 'Test-suite status was not recorded for this Review.' },
  ] satisfies {
    testStatus: InstalledDependencies['testStatus'];
    expected: string;
  }[])('preserves the structured $testStatus full-suite outcome', ({ testStatus, expected }) => {
    const prompt = buildReviewPrompt({ ...input, dependencyInstall: installed(testStatus) });

    expect(prompt).toContain(expected);
    expect(prompt).not.toContain('Sandy deferred the full project test suite');
    expect(prompt).toContain('Do NOT run root or whole-monorepo test suites');
  });

  it('includes failed-suite diagnostics without replacing the structured outcome', () => {
    const prompt = buildReviewPrompt({
      ...input,
      dependencyInstall: {
        ...installed('failed'),
        testResult: 'pnpm test exited 1.\nFAIL src/widget.test.ts: expected true, received false',
      },
    });

    expect(prompt).toContain('Sandy attempted the project test suite once and it failed.');
    expect(prompt).toContain('FAIL src/widget.test.ts: expected true, received false');
  });

  it.each([
    {
      dependencyInstall: { status: 'skipped', reason: 'no package.json' },
      expected: 'no package.json',
    },
    {
      dependencyInstall: { status: 'failed', command: 'npm ci', error: 'registry unavailable' },
      expected: 'registry unavailable',
    },
  ] satisfies {
    dependencyInstall: DependencyInstallResult;
    expected: string;
  }[])('keeps unavailable dependencies in static-analysis mode: $dependencyInstall.status', ({
    dependencyInstall,
    expected,
  }) => {
    const prompt = buildReviewPrompt({ ...input, dependencyInstall });

    expect(prompt).toContain(expected);
    expect(prompt).toContain('node_modules is NOT available.');
    expect(prompt).toContain('Do NOT run package-manager or test commands');
    expect(prompt).toContain('Limit yourself to static analysis.');
    expect(prompt).not.toContain('You MAY run focused package scripts');
  });

  it('makes no toolchain claims when no installation outcome is provided', () => {
    const prompt = buildReviewPrompt(input);

    expect(prompt).not.toContain('Review toolchain:');
    expect(prompt).not.toContain('node_modules is');
    expect(prompt).not.toContain('Sandy deferred the full project test suite');
  });

  it('keeps rules, ignored paths, manifest provenance, and sibling revisions in context', () => {
    const manifest =
      '# API Surface Manifest\nPackage: next @ 16.0.0\nDeclared In: apps/web/package.json';
    const prompt = buildReviewPrompt({
      ...input,
      apiSurfaceManifest: manifest,
      siblingWorktrees: [
        { repo: 'acme/consumer', sha: 'b'.repeat(40), hostPath: '/review/consumer' },
      ],
      botConfig: {
        repoRules: 'Keep widget ordering stable.',
        productRules: 'Consumers expect a string identifier.',
        ignorePatterns: ['generated/**'],
      },
    });

    expect(prompt).toContain(input.agent.systemPrompt);
    expect(prompt).toContain('Keep widget ordering stable.');
    expect(prompt).toContain('Consumers expect a string identifier.');
    expect(prompt).toContain('If an active Rule conflicts with a seed example, follow the Rule.');
    expect(prompt).toContain('- generated/**');
    expect(prompt).toContain('If a diff tool still displays an ignored path, disregard that file');
    expect(prompt).toContain(manifest);
    expect(prompt).toContain(`/review/consumer -> acme/consumer @ ${'b'.repeat(40)}`);
  });

  it('focuses investigation without weakening source verification or finding evidence', () => {
    const prompt = buildReviewPrompt(input);

    expect(prompt).toContain('Read the supplied diff first.');
    expect(prompt).toContain('concrete candidate bugs in touched behavior');
    expect(prompt).toContain('following relevant callers and consumers');
    expect(prompt).toContain('Batch independent read-only searches and focused reads');
    expect(prompt).toContain("when they do not depend on each other's results");
    expect(prompt).toContain('Avoid speculative broad test or build sweeps.');
    expect(prompt).toContain(
      'Once the diff is covered and every candidate is confirmed or suppressed',
    );
    expect(prompt).toContain('Do not fetch dependency source preemptively.');
    expect(prompt).toContain(
      "verify that behavior against the installed version's source with opensrc",
    );
    expect(prompt).toContain('Record the verification in the Finding.evidence');
    expect(prompt).toContain(
      "cannot verify enough for the Finding's confidence, suppress the Finding",
    );
    expect(prompt).toContain('Confirm each hit is a real usage');
    expect(prompt).toContain('Never report coincidental string matches.');
    expect(prompt).toContain('Each finding must use an in-diff "anchor"');
    expect(prompt).toContain('only for confirmed affected sibling-Repo consumers');
  });
});
