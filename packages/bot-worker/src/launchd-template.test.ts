import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const templatePath = fileURLToPath(
  new URL('../../../docs/setup/dev.sandy.worker.plist.template', import.meta.url),
);

describe('launchd worker template', () => {
  it('starts the built worker with the repo root as pnpm dir', () => {
    const template = readFileSync(templatePath, 'utf8');

    expect(plistStringArray(template, 'ProgramArguments')).toEqual([
      '__ABS_PATH_TO_PNPM__',
      '--dir',
      '__ABS_PATH_TO_SANDY_REPO__',
      'exec',
      'node',
      'packages/bot-worker/dist/main.js',
    ]);
    expect(plistStringValue(template, 'WorkingDirectory')).toBe('__ABS_PATH_TO_SANDY_REPO__');
  });
});

function plistStringArray(plist: string, key: string): string[] {
  const body = sectionAfterKey(plist, key, 'array');
  return [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1] ?? '');
}

function plistStringValue(plist: string, key: string): string | null {
  const body = sectionAfterKey(plist, key, 'string');
  return body.trim();
}

function sectionAfterKey(plist: string, key: string, tag: 'array' | 'string'): string {
  const keyMarker = `<key>${key}</key>`;
  const keyIndex = plist.indexOf(keyMarker);
  if (keyIndex === -1) {
    throw new Error(`Missing plist key ${key}`);
  }

  const startMarker = `<${tag}>`;
  const endMarker = `</${tag}>`;
  const start = plist.indexOf(startMarker, keyIndex);
  const end = plist.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(`Missing ${tag} section for plist key ${key}`);
  }
  return plist.slice(start + startMarker.length, end);
}
