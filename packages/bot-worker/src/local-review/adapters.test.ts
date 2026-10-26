import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureGit } from '../../../../test-support/git.js';
import { LocalDiffInspector, parseNumstat } from './adapters.js';

describe('parseNumstat', () => {
  it('reads counts, binary files, renames, and paths with tabs or newlines', () => {
    expect(
      parseNumstat(
        [
          '3\t1\tsrc/math.ts',
          '-\t-\tassets/logo.png',
          '2\t0\t',
          'src/old.ts',
          'src/new.ts',
          '1\t1\tdocs/a\tb\nc.md',
          '',
        ].join('\0'),
      ),
    ).toEqual([
      { added: 3, deleted: 1, path: 'src/math.ts' },
      { added: 0, deleted: 0, path: 'assets/logo.png' },
      { added: 2, deleted: 0, path: 'src/new.ts' },
      { added: 1, deleted: 1, path: 'docs/a\tb\nc.md' },
    ]);
    expect(parseNumstat('')).toEqual([]);
  });

  it('rejects records Git would never emit', () => {
    expect(() => parseNumstat('three\t1\tsrc/math.ts\0')).toThrow(
      'Git emitted an invalid numstat record',
    );
    expect(() => parseNumstat('1\t1\t\0src/old.ts\0')).toThrow(
      'Git emitted a numstat record without a path',
    );
  });
});

describe('LocalDiffInspector', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-local-diff-')));
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function git(...args: string[]): Promise<string> {
    return (await fixtureGit(['-C', root, ...args])).stdout.trim();
  }

  it('sizes the committed diff from the merge base, after ignore patterns', async () => {
    await git('init', '--quiet', '-b', 'main');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'old.ts'), 'export const value = 1;\n');
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'Base');
    const baseSha = await git('rev-parse', 'HEAD');
    await git('checkout', '--quiet', '-b', 'feature');
    await git('mv', 'src/old.ts', 'src/new.ts');
    await mkdir(join(root, 'generated'));
    await writeFile(join(root, 'generated', 'client.ts'), 'a\nb\nc\n');
    await writeFile(join(root, 'src', 'extra.ts'), 'export const extra = 2;\n');
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'Head');
    const headSha = await git('rev-parse', 'HEAD');
    // A later commit on the base is not part of the branch's diff.
    await git('checkout', '--quiet', 'main');
    await writeFile(join(root, 'src', 'later.ts'), 'export const later = 3;\n');
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'Later');
    const laterSha = await git('rev-parse', 'HEAD');
    const inspector = new LocalDiffInspector({ root, baseSha: laterSha, headSha });

    expect(await inspector.changedLineCount(undefined)).toBe(4);
    expect(inspector.changedLines).toBe(4);
    expect(await inspector.changedLineCount(undefined, ['generated/'])).toBe(1);
    expect((await inspector.changedPaths()).sort()).toEqual([
      'generated/client.ts',
      'src/extra.ts',
      'src/new.ts',
    ]);
    expect(
      await new LocalDiffInspector({ root, baseSha, headSha: baseSha }).changedLineCount(undefined),
    ).toBe(0);
  });
});
