import { matchesGlob } from 'node:path/posix';

/**
 * Return true when a PR base branch matches any configured Base-Branch Exclusion
 * pattern. Patterns are matched against the whole base ref: `main` matches only
 * `main`, while glob syntax such as `release/*` and `vendor/**` can cover branch
 * families.
 */
export function isBaseBranchExcluded(
  baseRef: string,
  patterns: readonly string[] | undefined = [],
): boolean {
  return patterns.some((rawPattern) => {
    const pattern = rawPattern.trim();
    return pattern.length > 0 && matchesGlob(baseRef, pattern);
  });
}
