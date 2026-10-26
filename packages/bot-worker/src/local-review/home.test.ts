import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireReviewLock,
  assertDedicatedHome,
  canonicalPath,
  ensureHomeDirectories,
  hasCodexLogin,
  hiddenPathsFrom,
  isWithin,
  localProtectedPaths,
  localReviewHome,
  pathExists,
  removeTree,
} from './home.js';

let root: string;
/** A synthetic home directory; no test reads the real one. */
let user: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sandy-local-home-')));
  user = join(root, 'user');
  await mkdir(user);
  vi.stubEnv('HOME', user);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTree(root);
});

describe('localReviewHome', () => {
  it('keeps state in ~/.sandy/cli with its own Codex home by default', () => {
    const state = join(user, '.sandy', 'cli');

    expect(localReviewHome({})).toEqual({
      root: state,
      codexHome: join(state, 'codex'),
      reviews: join(state, 'reviews'),
      worktrees: join(state, 'worktrees'),
      mirrors: join(state, 'mirrors'),
      repos: join(state, 'repos'),
      lock: join(state, 'review.lock'),
    });
  });

  it('prefers --codex-home over SANDY_CODEX_HOME and ignores blank values', () => {
    const env = {
      SANDY_CLI_HOME: join(root, 'state'),
      SANDY_CODEX_HOME: join(root, 'login', 'codex'),
    };

    expect(localReviewHome(env).root).toBe(join(root, 'state'));
    expect(localReviewHome(env).codexHome).toBe(join(root, 'login', 'codex'));
    expect(localReviewHome(env, join(root, 'flag', 'codex')).codexHome).toBe(
      join(root, 'flag', 'codex'),
    );
    expect(localReviewHome({ SANDY_CLI_HOME: ' ', SANDY_CODEX_HOME: '' }, ' ')).toEqual(
      localReviewHome({}),
    );
  });
});

describe('assertDedicatedHome', () => {
  it('accepts the default home', async () => {
    await expect(assertDedicatedHome(localReviewHome({}))).resolves.toBeUndefined();
  });

  it('refuses a state root that holds the home directory, including through a symlink', async () => {
    await symlink(user, join(root, 'alias'));

    for (const state of [user, root, join(root, 'alias')]) {
      await expect(assertDedicatedHome(localReviewHome({ SANDY_CLI_HOME: state }))).rejects.toThrow(
        'SANDY_CLI_HOME must be a dedicated directory, not your home directory or one of its parents',
      );
    }
  });

  it('refuses the personal Codex login', async () => {
    for (const codexHome of [join(user, '.codex'), join(user, '.codex', 'profiles', 'review')]) {
      await expect(assertDedicatedHome(localReviewHome({}, codexHome))).rejects.toThrow(
        'sandy review needs its own Codex login; ~/.codex is never used or copied',
      );
    }
  });

  it('refuses a Codex home whose parent is the home directory', async () => {
    await expect(assertDedicatedHome(localReviewHome({}, join(user, 'codex')))).rejects.toThrow(
      'The Codex home for sandy needs a dedicated parent directory',
    );
  });

  it('refuses a state root or Codex parent that is or holds a path hidden from reviewers', async () => {
    const refused = [
      [
        { SANDY_CLI_HOME: join(user, '.aws') },
        undefined,
        `SANDY_CLI_HOME must not be or contain ${join(user, '.aws')}`,
      ],
      [
        { SANDY_CLI_HOME: join(user, '.sandy') },
        undefined,
        `SANDY_CLI_HOME must not be or contain ${join(user, '.sandy')}`,
      ],
      [
        {},
        join(user, '.config', 'sandy-codex'),
        `The Codex home's parent must not be or contain ${join(user, '.config')}`,
      ],
      [
        {},
        join(user, '.cargo', 'codex'),
        `The Codex home's parent must not be or contain ${join(user, '.cargo', 'credentials')}`,
      ],
    ] as const;
    for (const [env, codexHome, message] of refused) {
      await expect(assertDedicatedHome(localReviewHome(env, codexHome))).rejects.toThrow(message);
    }
  });

  it('accepts a state root inside a credential directory, whose rest stays hidden', async () => {
    const home = localReviewHome({ SANDY_CLI_HOME: join(user, '.config', 'sandy') });

    await expect(assertDedicatedHome(home)).resolves.toBeUndefined();
  });
});

describe('ensureHomeDirectories', () => {
  it('creates owner-only directories, and a login exists only once Codex writes auth.json', async () => {
    const home = localReviewHome({ SANDY_CLI_HOME: join(root, 'state') });

    await ensureHomeDirectories(home);

    expect((await stat(home.root)).mode & 0o777).toBe(0o700);
    expect((await stat(home.codexHome)).mode & 0o777).toBe(0o700);
    expect(await hasCodexLogin(home)).toBe(false);
    await writeFile(join(home.codexHome, 'auth.json'), '{}\n', { mode: 0o600 });
    expect(await hasCodexLogin(home)).toBe(true);
  });
});

describe('localProtectedPaths', () => {
  it('hides existing checkouts, saved Reviews, operator config, and credential stores', async () => {
    const home = localReviewHome({});
    const checkout = join(root, 'work', 'widgets');
    const sandyRoot = join(root, 'sandy');
    const configPath = join(root, 'operator', 'bot.yaml');
    for (const directory of [
      home.reviews,
      home.codexHome,
      checkout,
      join(sandyRoot, '.config'),
      join(root, 'operator'),
      join(user, '.aws'),
      join(user, '.config', 'gh'),
      join(user, '.sandy', 'codex'),
      join(user, 'Library', 'Keychains'),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    for (const file of [
      configPath,
      join(user, '.npmrc'),
      join(user, '.sandy', 'codex', 'auth.json'),
    ]) {
      await writeFile(file, '{}\n');
    }

    const paths = await localProtectedPaths({
      home,
      checkoutRoots: [checkout],
      sandyRoot,
      configPath,
    });

    expect([...paths].sort()).toEqual(
      [
        checkout,
        home.reviews,
        join(sandyRoot, '.config'),
        configPath,
        ...(process.platform === 'darwin' ? [join(user, 'Library')] : []),
        join(user, '.config'),
        join(user, '.aws'),
        join(user, '.npmrc'),
        join(user, '.sandy', 'codex'),
      ].sort(),
    );
  });

  it('hides all of ~/.sandy when the CLI home lives elsewhere', async () => {
    const home = localReviewHome({ SANDY_CLI_HOME: join(root, 'state') });
    await mkdir(join(user, '.sandy', 'codex'), { recursive: true });
    await mkdir(home.codexHome, { recursive: true });

    expect(
      await localProtectedPaths({ home, checkoutRoots: [], sandyRoot: join(root, 'sandy') }),
    ).toEqual([join(user, '.sandy')]);
  });

  it('hides the rest of a credential directory that holds the CLI home', async () => {
    const home = localReviewHome({ SANDY_CLI_HOME: join(user, '.config', 'sandy') });
    await mkdir(home.codexHome, { recursive: true });
    await mkdir(join(user, '.config', 'gh'));
    await writeFile(join(user, '.config', 'gcloud.json'), '{}\n');

    const paths = await localProtectedPaths({
      home,
      checkoutRoots: [],
      sandyRoot: join(root, 'sandy'),
    });

    expect([...paths].sort()).toEqual([
      join(user, '.config', 'gcloud.json'),
      join(user, '.config', 'gh'),
    ]);
  });

  it('hides the existing paths the developer adds', async () => {
    const home = localReviewHome({ SANDY_CLI_HOME: join(root, 'state') });
    await mkdir(join(user, '.tool'));
    await writeFile(join(user, '.tool', 'auth.json'), '{}\n');

    expect(
      await localProtectedPaths({
        home,
        checkoutRoots: [],
        sandyRoot: join(root, 'sandy'),
        hiddenPaths: [join(user, '.tool'), join(user, '.missing')],
      }),
    ).toEqual([join(user, '.tool')]);
  });

  it('stops at a symlink that leads back into a directory it already split', async () => {
    const home = localReviewHome({ SANDY_CLI_HOME: join(user, '.config', 'sandy') });
    await mkdir(home.codexHome, { recursive: true });
    await symlink(join(user, '.config'), join(user, '.config', 'loop'));

    expect(
      await localProtectedPaths({ home, checkoutRoots: [], sandyRoot: join(root, 'sandy') }),
    ).toEqual([]);
  });
});

describe('hiddenPathsFrom', () => {
  it('splits SANDY_REVIEW_HIDDEN_PATHS like PATH and skips blank entries', () => {
    expect(hiddenPathsFrom({})).toEqual([]);
    expect(
      hiddenPathsFrom({ SANDY_REVIEW_HIDDEN_PATHS: ` /a/tool${delimiter}${delimiter}/b/notes ` }),
    ).toEqual(['/a/tool', '/b/notes']);
  });

  it('refuses a relative path, such as an unexpanded ~', () => {
    expect(() =>
      hiddenPathsFrom({ SANDY_REVIEW_HIDDEN_PATHS: `/a/tool${delimiter}~/.tool` }),
    ).toThrow('SANDY_REVIEW_HIDDEN_PATHS takes absolute paths; got ~/.tool');
  });
});

describe('acquireReviewLock', () => {
  it('holds one Review at a time and releases its own lock', async () => {
    const lock = join(root, 'state', 'review.lock');

    const release = await acquireReviewLock(lock);

    expect(await readFile(lock, 'utf8')).toBe(`${process.pid}\n`);
    await expect(acquireReviewLock(lock)).rejects.toThrow(
      `Another sandy review is running (pid ${process.pid}); wait for it to finish`,
    );
    await release();
    expect(await pathExists(lock)).toBe(false);
    await (await acquireReviewLock(lock))();
  });

  it('reclaims a lock whose owner has exited', async () => {
    const lock = join(root, 'review.lock');
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    await writeFile(lock, `${pid}\n`);

    const release = await acquireReviewLock(lock);

    expect(await readFile(lock, 'utf8')).toBe(`${process.pid}\n`);
    await release();
  });

  it('waits on a lock without an owner only while it is fresh', async () => {
    const lock = join(root, 'review.lock');
    await writeFile(lock, '');

    await expect(acquireReviewLock(lock)).rejects.toThrow(
      'Another sandy review is running; wait for it to finish',
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await (await acquireReviewLock(lock))();
  });

  it('leaves a lock that another Review took over', async () => {
    const lock = join(root, 'review.lock');
    const release = await acquireReviewLock(lock);
    await writeFile(lock, '1\n');

    await release();

    expect(await readFile(lock, 'utf8')).toBe('1\n');
  });
});

describe('paths', () => {
  it('removes a tree whose directories lost owner write access', async () => {
    const tree = join(root, 'tree');
    await mkdir(join(tree, 'locked', 'deeper'), { recursive: true });
    await writeFile(join(tree, 'locked', 'deeper', 'file.txt'), 'x\n');
    await chmod(join(tree, 'locked', 'deeper'), 0o500);
    await chmod(join(tree, 'locked'), 0o500);

    await removeTree(tree);

    expect(await pathExists(tree)).toBe(false);
  });

  it('resolves symlinks through the deepest existing ancestor', async () => {
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'));

    expect(await canonicalPath(join(root, 'link', 'missing', 'child'))).toBe(
      join(root, 'real', 'missing', 'child'),
    );
  });

  it('compares whole path segments', () => {
    expect(isWithin('/a/b', '/a')).toBe(true);
    expect(isWithin('/a', '/a')).toBe(true);
    expect(isWithin('/a/..b', '/a')).toBe(true);
    expect(isWithin('/ab', '/a')).toBe(false);
    expect(isWithin('/a', '/a/b')).toBe(false);
  });
});
