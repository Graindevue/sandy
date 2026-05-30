import { describe, expect, it } from 'vitest';
import { isIgnoredPath, parseIgnoreGitignore } from './ignore.js';

describe('parseIgnoreGitignore', () => {
  it('drops comments and blank lines while preserving pattern text', () => {
    expect(
      parseIgnoreGitignore(`
# generated files
generated/**

*.snap
\\#literal.md
\\!literal.md
!generated/keep.ts
`),
    ).toEqual(['generated/**', '*.snap', '\\#literal.md', '\\!literal.md', '!generated/keep.ts']);
  });
});

describe('isIgnoredPath', () => {
  it('matches basename, directory, anchored, and later negated patterns', () => {
    const patterns = parseIgnoreGitignore(`
generated/**
*.snap
/build/
!generated/keep.ts
`);

    expect(isIgnoredPath('generated/api.ts', patterns)).toBe(true);
    expect(isIgnoredPath('tests/widget.snap', patterns)).toBe(true);
    expect(isIgnoredPath('build/out.js', patterns)).toBe(true);
    expect(isIgnoredPath('src/build/out.js', patterns)).toBe(false);
    expect(isIgnoredPath('generated/keep.ts', patterns)).toBe(false);
  });

  it('treats escaped leading comment and negation markers as literals', () => {
    const patterns = parseIgnoreGitignore(`
\\#notes.md
\\!important.md
`);

    expect(isIgnoredPath('#notes.md', patterns)).toBe(true);
    expect(isIgnoredPath('!important.md', patterns)).toBe(true);
  });

  it('lets double-star span zero or more path segments', () => {
    const patterns = parseIgnoreGitignore('src/**/schema.ts\n');

    expect(isIgnoredPath('src/schema.ts', patterns)).toBe(true);
    expect(isIgnoredPath('src/db/schema.ts', patterns)).toBe(true);
  });
});
