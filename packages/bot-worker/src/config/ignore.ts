export interface DiffIgnoreOptions {
  ignorePatterns?: readonly string[];
}

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
    const pattern = parseIgnoreLine(rawPattern);
    if (pattern === null) {
      continue;
    }
    const negated = pattern.startsWith('!');
    const effectivePattern = negated ? pattern.slice(1) : pattern;
    if (effectivePattern.length === 0) {
      continue;
    }
    if (matchesPattern(normalizedPath, effectivePattern)) {
      ignored = !negated;
    }
  }
  return ignored;
}

function parseIgnoreLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return null;
  }
  if (trimmed.startsWith('\\#') || trimmed.startsWith('\\!')) {
    return trimmed.slice(1);
  }
  return trimmed;
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
      if (!globMatches(segment, pattern)) {
        return false;
      }
      return !directoryOnly || index < segments.length - 1;
    });
  }

  const expression = globToRegExp(pattern);
  const candidates = anchored ? [path] : pathSuffixes(path);
  return candidates.some((candidate) => {
    if (directoryOnly) {
      return expression.test(candidate) || candidate.startsWith(`${pattern}/`);
    }
    return expression.test(candidate);
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

function globMatches(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(char ?? '');
  }
  source += '$';
  return new RegExp(source);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
