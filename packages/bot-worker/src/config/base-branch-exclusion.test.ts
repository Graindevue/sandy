import { describe, expect, it } from 'vitest';
import { isBaseBranchExcluded } from './base-branch-exclusion.js';

describe('isBaseBranchExcluded', () => {
  it.each([
    ['main', ['main'], true],
    ['feature/main', ['main'], false],
    ['release/2026.06', ['release/*'], true],
    ['release/2026/06', ['release/*'], false],
    ['vendor/generated/current', ['vendor/**'], true],
    ['feature/vendor/generated', ['vendor/**'], false],
    ['sandbox', ['release/*', 'sandbox'], true],
    ['main', ['release/*', 'vendor/**'], false],
    ['Release/2026.06', ['release/*'], false],
    ['main', [], false],
    ['main', undefined, false],
  ] satisfies Array<
    [string, readonly string[] | undefined, boolean]
  >)('matches base %j against patterns %j => %s', (baseRef, patterns, expected) => {
    expect(isBaseBranchExcluded(baseRef, patterns)).toBe(expected);
  });
});
