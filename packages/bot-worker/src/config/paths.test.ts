import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCloneBaseDir, defaultConfigLoaderOptions } from './paths.js';

/**
 * The config layer's path defaults: where Sandy looks for `bot.yaml`, the
 * default and override Agent directories, and the clone scratch space. Pure path
 * arithmetic — no disk access — so these assert structure, not contents.
 */

describe('defaultConfigLoaderOptions', () => {
  it('roots bot.yaml and the override dir under <repoRoot>/.config and defaults under <repoRoot>/agents', () => {
    const opts = defaultConfigLoaderOptions('/srv/sandy');

    expect(opts.botYamlPath).toBe(join('/srv/sandy', '.config', 'bot.yaml'));
    expect(opts.agentsDir).toBe(join('/srv/sandy', 'agents'));
    expect(opts.overridesDir).toBe(join('/srv/sandy', '.config', 'agents'));
  });
});

describe('defaultCloneBaseDir', () => {
  it('honors SANDY_CLONE_DIR when set', () => {
    expect(defaultCloneBaseDir({ SANDY_CLONE_DIR: '/data/clones' })).toBe('/data/clones');
  });

  it('falls back to ~/.sandy/repos, kept out of the Sandy repo', () => {
    const dir = defaultCloneBaseDir({});

    expect(dir).toBe(join(homedir(), '.sandy', 'repos'));
    expect(isAbsolute(dir)).toBe(true);
  });

  it('ignores an empty SANDY_CLONE_DIR and uses the fallback', () => {
    expect(defaultCloneBaseDir({ SANDY_CLONE_DIR: '' })).toBe(join(homedir(), '.sandy', 'repos'));
  });
});
