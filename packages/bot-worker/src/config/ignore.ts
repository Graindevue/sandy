import { matchesGlob } from 'node:path';

export function parseIgnoreGitignore(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map(parseIgnoreLine)
    .filter((line): line is string => line !== null);
}

export function isIgnoredPath(path: string, patterns: readonly string[] = []): boolean {
  const normalizedPath = normalizePath(path);
  let ignored = false;
  for (const rawPattern of patterns) {
    const parsed = parseIgnorePattern(rawPattern);
    if (parsed === null) {
      continue;
    }
    if (matchesPattern(normalizedPath, parsed.pattern)) {
      ignored = !parsed.negated;
    }
  }
  return ignored;
}

function parseIgnoreLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return null;
  }
  return trimmed;
}

function parseIgnorePattern(raw: string): { pattern: string; negated: boolean } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith('\\#') || trimmed.startsWith('\\!')) {
    return { pattern: trimmed.slice(1), negated: false };
  }

  const negated = trimmed.startsWith('!');
  const pattern = negated ? trimmed.slice(1) : trimmed;
  return pattern.length === 0 ? null : { pattern, negated };
}

function matchesPattern(path: string, rawPattern: string): boolean {
  const normalizedPattern = normalizePath(rawPattern);
  const directoryOnly = normalizedPattern.endsWith('/');
  const anchored = normalizedPattern.startsWith('/');
  const pattern = normalizedPattern.replace(/^\/+/, '').replace(/\/+$/, '');
  if (pattern.length === 0) {
    return false;
  }

  if (!anchored && !pattern.includes('/')) {
    return path.split('/').some((segment, index, segments) => {
      if (!matchesGlob(segment, pattern)) {
        return false;
      }
      return !directoryOnly || index < segments.length - 1;
    });
  }

  const candidates = anchored ? [path] : pathSuffixes(path);
  return candidates.some((candidate) => {
    if (directoryOnly) {
      return matchesGlob(candidate, pattern) || matchesGlob(candidate, `${pattern}/**`);
    }
    return matchesGlob(candidate, pattern);
  });
}

function pathSuffixes(path: string): string[] {
  const parts = path.split('/');
  const suffixes: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    suffixes.push(parts.slice(index).join('/'));
  }
  return suffixes;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}
