import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMainModule, loadConfig } from './main.js';

describe('loadConfig PORT validation', () => {
  // Finding #8: PORT was parsed with Number.parseInt, which silently accepts
  // trailing garbage and scientific notation ('1e4' -> 1, '3007abc' -> 3007),
  // mis-binding the server despite the "fails loudly" contract. The whole string
  // must be a positive integer in [1, 65535].
  const baseEnv = { WEBHOOK_SECRET: 'secret', CONVEX_URL: 'https://example.convex.cloud' };

  it.each([
    '1e4',
    '3007abc',
    '',
    '0',
    '70000',
    ' 3007',
    '3007 ',
    '-1',
    '3.5',
    '0x10',
    'abc',
  ])('rejects PORT=%j', (port) => {
    expect(() => loadConfig({ ...baseEnv, PORT: port })).toThrow(/PORT/);
  });

  it('accepts a valid PORT', () => {
    expect(loadConfig({ ...baseEnv, PORT: '8080' }).port).toBe(8080);
  });

  it('accepts the boundary ports 1 and 65535', () => {
    expect(loadConfig({ ...baseEnv, PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...baseEnv, PORT: '65535' }).port).toBe(65535);
  });

  it('falls back to the default port when PORT is unset', () => {
    expect(loadConfig(baseEnv).port).toBe(3007);
  });
});

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
