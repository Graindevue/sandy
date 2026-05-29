import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMainModule } from './main.js';

describe('isMainModule', () => {
  // Finding #1: the run-when-direct guard must encode the script path the same
  // way `import.meta.url` is encoded. A raw `file://${argv1}` concat fails on any
  // path with a space (or #, ?, %, non-ASCII), so `main()` never runs and the
  // worker boots without binding a port. Build the expected URL with
  // pathToFileURL — the source of truth Node uses for `import.meta.url`.
  it('matches when the script path contains a space', () => {
    const argv1 = '/Users/me/My Apps/sandy/dist/main.js';
    const importMetaUrl = pathToFileURL(argv1).href;
    // Encoded, so the space is %20 — a raw concat would not produce this.
    expect(importMetaUrl).toContain('%20');
    expect(isMainModule(importMetaUrl, argv1)).toBe(true);
  });

  it('matches for paths with other characters that require percent-encoding', () => {
    for (const argv1 of [
      '/srv/app#1/dist/main.js',
      '/srv/app?x/dist/main.js',
      '/srv/50%/dist/main.js',
      '/srv/café/dist/main.js',
    ]) {
      expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
    }
  });

  it('matches a plain ASCII path with no special characters', () => {
    const argv1 = '/srv/app/dist/main.js';
    expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
  });

  it('does not match when the module was imported (different path) or argv1 is absent', () => {
    const argv1 = '/srv/app/dist/main.js';
    expect(isMainModule(pathToFileURL('/srv/app/dist/other.js').href, argv1)).toBe(false);
    expect(isMainModule(pathToFileURL(argv1).href, undefined)).toBe(false);
  });
});
