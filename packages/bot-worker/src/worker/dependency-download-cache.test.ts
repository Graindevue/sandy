import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { CodexExecRunner } from './codex-exec-runner.js';
import { createGitHubDependencyDownloadCache } from './github-dependency-download-cache.js';

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove();
});

async function preparationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sandy-download-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const pkg = join(root, 'package');
  await mkdir(repo);
  await mkdir(pkg);
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'download-fixture', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(join(pkg, 'index.js'), 'module.exports = "downloaded dependency";');
  await exec('tar', ['-czf', join(root, 'dependency.tgz'), 'package'], { cwd: root });
  const tarball = await readFile(join(root, 'dependency.tgz'));
  let downloads = 0;
  const server = createServer((_, response) => {
    downloads++;
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(tarball);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture server');
  const version = (await exec('npm', ['--version'])).stdout.trim();
  const manifest = {
    name: 'review-fixture',
    version: '1.0.0',
    packageManager: `npm@${version}`,
    dependencies: { 'download-fixture': '1.0.0' },
    scripts: {
      postinstall: "node -e \"require('node:fs').appendFileSync('installed.txt','installed\\n')\"",
    },
  };
  const lockfile = JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      '': {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
        hasInstallScript: true,
      },
      'node_modules/download-fixture': {
        version: '1.0.0',
        resolved: `http://127.0.0.1:${address.port}/dependency.tgz`,
        integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      },
    },
  });
  await writeFile(join(repo, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(repo, 'package-lock.json'), lockfile);
  await exec('git', ['init'], { cwd: repo });
  const executable = join(root, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
    const profile = process.argv.find(value => value.startsWith('permissions.sandy='));
    if (!profile?.includes(${JSON.stringify(`${JSON.stringify(join(root, 'sandy-dependency-downloads'))}="deny"`)})) throw new Error('Publication store must be denied to reviewed commands');
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit', env: process.env });
    child.on('close', code => process.exit(code ?? 1));
  `,
  );
  await chmod(executable, 0o755);
  const entries = new Map<string, string>();
  const saved: string[][] = [];
  const cache = {
    async restore(input: { key: string; storePath: string }) {
      const source = entries.get(input.key);
      if (source === undefined) return undefined;
      await cp(source, input.storePath, { recursive: true });
      return input.key;
    },
    async save(input: { key: string; storePath: string }) {
      const destination = join(root, `saved-${entries.size}`);
      await cp(input.storePath, destination, { recursive: true });
      entries.set(input.key, destination);
      saved.push(await readdir(destination, { recursive: true }));
    },
  };
  const runner = new CodexExecRunner({
    codexHome: join(root, 'ci-codex'),
    executable,
    dependencyDownloadCache: cache,
  });
  return {
    root,
    repo,
    runner,
    cache,
    entries,
    saved,
    manifest,
    lockfile,
    executable,
    downloads: () => downloads,
    resetDownloads: () => {
      downloads = 0;
    },
  };
}

it('reuses downloaded packages while performing a fresh frozen installation for every preparation', async () => {
  const fixture = await preparationFixture();
  const input = { worktreePath: fixture.repo, cacheKey: 'acme/review-fixture' };
  expect(await fixture.runner.installDependencies(input)).toMatchObject({ status: 'installed' });
  expect(fixture.downloads()).toBe(1);
  expect(fixture.saved).toHaveLength(1);
  await writeFile(
    join(fixture.repo, 'node_modules/download-fixture/index.js'),
    'stale installed tree',
  );
  expect(await fixture.runner.installDependencies(input)).toMatchObject({
    status: 'installed',
    cache: { restore: 'hit' },
  });
  expect(fixture.downloads()).toBe(1);
  expect(await readFile(join(fixture.repo, 'node_modules/download-fixture/index.js'), 'utf8')).toBe(
    'module.exports = "downloaded dependency";',
  );
  expect(await readFile(join(fixture.repo, 'installed.txt'), 'utf8')).toBe(
    'installed\ninstalled\n',
  );
  expect(await readFile(join(fixture.repo, 'package-lock.json'), 'utf8')).toBe(fixture.lockfile);
  expect(fixture.saved.flat().join('\n')).not.toMatch(
    /node_modules|auth\.json|\.npmrc|_logs|package\.json/,
  );
}, 20_000);

it('retains cold installation when the optional cache service fails', async () => {
  const fixture = await preparationFixture();
  fixture.cache.restore = async () => {
    throw new Error('cache unavailable');
  };
  fixture.cache.save = async () => {
    throw new Error('cache unavailable');
  };
  expect(
    await fixture.runner.installDependencies({
      worktreePath: fixture.repo,
      cacheKey: 'acme/fixture',
    }),
  ).toMatchObject({
    status: 'installed',
    cache: { restore: 'unavailable', save: 'unavailable' },
  });
  expect(fixture.downloads()).toBe(1);
}, 20_000);

it('publishes only npm downloads captured before reviewed lifecycle output enters the content store', async () => {
  const fixture = await preparationFixture();
  await writeFile(
    join(fixture.repo, 'package.json'),
    JSON.stringify({
      ...fixture.manifest,
      scripts: { postinstall: 'node poison-store.cjs' },
    }),
  );
  await writeFile(
    join(fixture.repo, 'poison-store.cjs'),
    `
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
    fs.appendFileSync('lifecycle.txt', 'ran\\n');
    const content = 'simulated-source-credential-and-review-output';
    const hash = crypto.createHash('sha512').update(content).digest('hex');
    const destination = path.join(process.env.npm_config_cache, '_cacache', 'content-v2', 'sha512', hash.slice(0,2), hash.slice(2,4), hash.slice(4));
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.writeFileSync(destination, content);
  `,
  );
  expect(
    await fixture.runner.installDependencies({
      worktreePath: fixture.repo,
      cacheKey: 'acme/safe-npm',
    }),
  ).toMatchObject({
    status: 'installed',
    cache: { save: 'saved' },
  });
  const snapshot = [...fixture.entries.values()][0];
  if (!snapshot) throw new Error('Missing published snapshot');
  const contents = await Promise.all(
    (await readdir(snapshot, { recursive: true }))
      .filter((name) => /^content-v2\/sha512\/[^/]+\/[^/]+\/[^/]+$/.test(name))
      .map((name) => readFile(join(snapshot, name))),
  );
  expect(
    contents.some((bytes) => bytes.includes('simulated-source-credential-and-review-output')),
  ).toBe(false);
  expect(contents.length).toBeGreaterThan(0);
  expect(fixture.downloads()).toBe(1);
  expect(await readFile(join(fixture.repo, 'lifecycle.txt'), 'utf8')).toBe('ran\n');
}, 20_000);

it('discards an unsafe restored store without exposing its symlink target to installation', async () => {
  const fixture = await preparationFixture();
  fixture.cache.restore = async (input) => {
    await (await import('node:fs/promises')).symlink(
      join(fixture.root, 'package'),
      join(input.storePath, 'content-v2'),
    );
    return input.key;
  };
  expect(
    await fixture.runner.installDependencies({
      worktreePath: fixture.repo,
      cacheKey: 'acme/fixture',
    }),
  ).toMatchObject({ status: 'installed', cache: { restore: 'unavailable' } });
  expect(fixture.downloads()).toBe(1);
  expect(await readFile(join(fixture.root, 'package/index.js'), 'utf8')).toBe(
    'module.exports = "downloaded dependency";',
  );
}, 20_000);

it('does not publish credential or installed-tree entries added to a download store by lifecycle code', async () => {
  const fixture = await preparationFixture();
  await writeFile(
    join(fixture.repo, 'package.json'),
    JSON.stringify({
      ...fixture.manifest,
      scripts: {
        postinstall:
          "node -e \"require('node:fs').writeFileSync(require('node:path').join(process.env.npm_config_cache,'_cacache/auth.json'),'credential')\"",
      },
    }),
  );
  expect(
    await fixture.runner.installDependencies({
      worktreePath: fixture.repo,
      cacheKey: 'acme/fixture',
    }),
  ).toMatchObject({ status: 'installed', cache: { save: 'saved' } });
  expect(fixture.saved).toHaveLength(1);
  expect(fixture.saved.flat().join('\n')).not.toContain('auth.json');
}, 20_000);

it('retries once with discarded downloads when a restored installation fails', async () => {
  const fixture = await preparationFixture();
  const input = { worktreePath: fixture.repo, cacheKey: 'acme/fixture' };
  expect(await fixture.runner.installDependencies(input)).toMatchObject({ status: 'installed' });
  await writeFile(
    fixture.executable,
    `#!/usr/bin/env node
    const fs = await import('node:fs/promises');
    if (process.argv.at(-1).includes(' ci ')) {
      const marker = ${JSON.stringify(join(fixture.root, 'failed-cache-install'))};
      try { await fs.access(marker); } catch {
        await fs.writeFile(marker, 'corrupt restored store');
        process.stderr.write('restored package integrity failed');
        process.exit(1);
      }
    }
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit', env: process.env });
    child.on('close', code => process.exit(code ?? 1));
  `,
  );
  expect(await fixture.runner.installDependencies(input)).toMatchObject({
    status: 'installed',
    cache: { restore: 'discarded', coldRetry: true },
  });
  expect(fixture.downloads()).toBe(2);
  expect(await readFile(join(fixture.repo, 'installed.txt'), 'utf8')).toBe(
    'installed\ninstalled\n',
  );
}, 20_000);

it.each([
  'repository',
  'lockfile',
  'configuration',
])('does not reuse downloads after changing reviewed %s identity', async (change) => {
  const fixture = await preparationFixture();
  expect(
    await fixture.runner.installDependencies({
      worktreePath: fixture.repo,
      cacheKey: 'acme/fixture',
    }),
  ).toMatchObject({ status: 'installed' });
  if (change === 'lockfile')
    await writeFile(join(fixture.repo, 'package-lock.json'), `${fixture.lockfile}\n`);
  if (change === 'configuration')
    await writeFile(join(fixture.repo, '.npmrc'), 'strict-ssl=true\n');
  expect(
    await fixture.runner.installDependencies({
      worktreePath: fixture.repo,
      cacheKey: change === 'repository' ? 'other/fixture' : 'acme/fixture',
    }),
  ).toMatchObject({ status: 'installed', cache: { restore: 'miss' } });
  expect(fixture.downloads()).toBe(2);
  expect(fixture.entries.size).toBe(2);
  expect([...fixture.entries.keys()][0]).toContain(
    `-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}-npm@`,
  );
}, 20_000);

it.each([
  'missing repository',
  'unpinned manager',
  'different manager version',
  'credential configuration',
])('keeps ordinary preparation for %s', async (reason) => {
  const fixture = await preparationFixture();
  if (reason === 'unpinned manager')
    await writeFile(
      join(fixture.repo, 'package.json'),
      JSON.stringify({ ...fixture.manifest, packageManager: undefined }),
    );
  if (reason === 'different manager version')
    await writeFile(
      join(fixture.repo, 'package.json'),
      JSON.stringify({ ...fixture.manifest, packageManager: 'npm@1.0.0' }),
    );
  if (reason === 'credential configuration')
    await writeFile(
      join(fixture.repo, '.npmrc'),
      '//example.test/:_authToken=private-fixture-token\n',
    );
  expect(
    await fixture.runner.installDependencies({
      worktreePath: fixture.repo,
      ...(reason === 'missing repository' ? {} : { cacheKey: 'acme/fixture' }),
    }),
  ).toMatchObject({ status: 'installed', cache: { restore: 'unverified' } });
  expect(fixture.saved).toHaveLength(0);
}, 20_000);

it('retains dependency failure and publishes no cache when a cold install fails', async () => {
  const fixture = await preparationFixture();
  await writeFile(
    join(fixture.repo, 'package.json'),
    JSON.stringify({ ...fixture.manifest, dependencies: { absent: '1.0.0' } }),
  );
  expect(
    await fixture.runner.installDependencies({
      worktreePath: fixture.repo,
      cacheKey: 'acme/fixture',
    }),
  ).toMatchObject({ status: 'failed' });
  expect(fixture.saved).toHaveLength(0);
}, 20_000);

it.each([
  '10.34.1',
  'current',
])('uses pinned pnpm %s downloads without sharing installed dependencies or side effects', async (pin) => {
  const fixture = await preparationFixture();
  const version =
    pin === 'current'
      ? (await exec('pnpm', ['--version'], { cwd: fixture.root })).stdout.trim()
      : pin;
  const lock = JSON.parse(fixture.lockfile) as { packages: Record<string, { resolved?: string }> };
  const url = lock.packages['node_modules/download-fixture']?.resolved;
  if (!url) throw new Error('Missing dependency URL');
  await writeFile(
    join(fixture.repo, 'package.json'),
    JSON.stringify({
      ...fixture.manifest,
      packageManager: `pnpm@${version}`,
      dependencies: { 'download-fixture': url },
    }),
  );
  await rm(join(fixture.repo, 'package-lock.json'));
  await exec(
    'npx',
    [
      '--yes',
      `pnpm@${version}`,
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--store-dir',
      join(fixture.root, 'fixture-lock-store'),
    ],
    { cwd: fixture.repo },
  );
  fixture.resetDownloads();
  const input = { worktreePath: fixture.repo, cacheKey: 'acme/pnpm-fixture' };
  expect(await fixture.runner.installDependencies(input)).toMatchObject({
    status: 'installed',
    cache: { save: 'saved' },
  });
  expect(fixture.downloads()).toBe(1);
  await rm(join(fixture.repo, 'node_modules'), { recursive: true });
  expect(await fixture.runner.installDependencies(input)).toMatchObject({
    status: 'installed',
    cache: { restore: 'hit' },
  });
  expect(fixture.downloads()).toBe(1);
  const resolved = await exec('node', ['-e', 'console.log(require("download-fixture"))'], {
    cwd: fixture.repo,
  });
  expect(resolved.stdout.trim()).toBe('downloaded dependency');
  expect(fixture.saved.flat().join('\n')).not.toMatch(
    /node_modules|projects|side_effects|auth\.json|\.npmrc/,
  );
}, 60_000);

it('falls back to preparation when the bounded GitHub cache adapter has no service', async () => {
  const fixture = await preparationFixture();
  const runner = new CodexExecRunner({
    codexHome: join(fixture.root, 'ci-codex'),
    executable: fixture.executable,
    dependencyDownloadCache: createGitHubDependencyDownloadCache({ env: {}, timeoutMs: 1000 }),
  });
  expect(
    await runner.installDependencies({ worktreePath: fixture.repo, cacheKey: 'acme/fixture' }),
  ).toMatchObject({ status: 'installed', cache: { restore: 'unavailable', save: 'unavailable' } });
  expect(fixture.downloads()).toBe(1);
}, 20_000);

it('validates restored tarball integrity and redownloads corrupt content', async () => {
  const fixture = await preparationFixture();
  const input = { worktreePath: fixture.repo, cacheKey: 'acme/fixture' };
  expect(await fixture.runner.installDependencies(input)).toMatchObject({ status: 'installed' });
  const saved = [...fixture.entries.values()][0];
  if (saved === undefined) throw new Error('Missing saved downloads');
  const content = (await readdir(saved, { recursive: true })).find((name) =>
    /^content-v2\/sha512\/[^/]+\/[^/]+\/[^/]+$/.test(name),
  );
  if (content === undefined) throw new Error('Missing cached tarball');
  await writeFile(join(saved, content), 'invalid tarball content');
  expect(await fixture.runner.installDependencies(input)).toMatchObject({ status: 'installed' });
  expect(fixture.downloads()).toBe(2);
  expect(await readFile(join(fixture.repo, 'node_modules/download-fixture/index.js'), 'utf8')).toBe(
    'module.exports = "downloaded dependency";',
  );
}, 20_000);

it('publishes pnpm downloads before reviewed hooks and lifecycles can mutate their store', async () => {
  const fixture = await preparationFixture();
  const version = '10.34.1';
  const lock = JSON.parse(fixture.lockfile) as { packages: Record<string, { resolved?: string }> };
  const url = lock.packages['node_modules/download-fixture']?.resolved;
  if (!url) throw new Error('Missing dependency URL');
  await writeFile(
    join(fixture.repo, 'package.json'),
    JSON.stringify({
      ...fixture.manifest,
      packageManager: `pnpm@${version}`,
      dependencies: { 'download-fixture': url },
      scripts: { postinstall: 'node poison-store.cjs' },
    }),
  );
  await writeFile(
    join(fixture.repo, 'poison-store.cjs'),
    `
    const fs = require('node:fs'), path = require('node:path');
    fs.appendFileSync('lifecycle.txt', 'ran\\n');
    const store = process.env.npm_config_store_dir;
    if (!store) throw new Error('Missing writable store');
    fs.writeFileSync(path.join(store, 'auth.json'), 'must never be cached');
    fs.writeFileSync('node_modules/download-fixture/index.js', 'module.exports = "modified installed dependency";');
  `,
  );
  await rm(join(fixture.repo, 'package-lock.json'));
  await exec(
    'npx',
    [
      '--yes',
      `pnpm@${version}`,
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--store-dir',
      join(fixture.root, 'fixture-lock-store'),
    ],
    { cwd: fixture.repo },
  );
  await writeFile(
    join(fixture.repo, '.pnpmfile.cjs'),
    `
    const fs = require('node:fs');
    fs.appendFileSync('hooks.txt', 'reviewed hook ran\\n');
    module.exports = {};
  `,
  );
  fixture.resetDownloads();
  const input = { worktreePath: fixture.repo, cacheKey: 'acme/safe-pnpm' };
  expect(await fixture.runner.installDependencies(input)).toMatchObject({
    status: 'installed',
    cache: { save: 'saved' },
  });
  expect(fixture.saved.flat().join('\n')).not.toContain('auth.json');
  expect(await readFile(join(fixture.repo, 'hooks.txt'), 'utf8')).toBe('reviewed hook ran\n');
  expect(await readFile(join(fixture.repo, 'lifecycle.txt'), 'utf8')).toBe('ran\n');
  expect(await readFile(join(fixture.repo, 'node_modules/download-fixture/index.js'), 'utf8')).toBe(
    'module.exports = "modified installed dependency";',
  );
  const snapshot = [...fixture.entries.values()][0];
  if (!snapshot) throw new Error('Missing published snapshot');
  const files = await readdir(snapshot, { recursive: true });
  const bytes = await Promise.all(
    files
      .filter((name) => /^v10\/files\/[a-f0-9]{2}\/[a-f0-9]+$/.test(name))
      .map((name) => readFile(join(snapshot, name), 'utf8')),
  );
  expect(bytes).toContain('module.exports = "downloaded dependency";');
  expect(bytes).not.toContain('module.exports = "modified installed dependency";');
}, 60_000);

it('reuses the same provider path across Reviews with distinct temporary Codex homes', async () => {
  const fixture = await preparationFixture();
  const publication = join(fixture.root, 'stable-reviewed-downloads');
  await writeFile(
    fixture.executable,
    `#!/usr/bin/env node
    const profile = process.argv.find(value => value.startsWith('permissions.sandy='));
    if (!profile?.includes(${JSON.stringify(`${JSON.stringify(publication)}="deny"`)})) throw new Error('Configured publication directory must be denied');
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit', env: process.env });
    child.on('close', code => process.exit(code ?? 1));
  `,
  );
  const paths = [];
  const cache = {
    async restore(input: { key: string; storePath: string }) {
      paths.push(input.storePath);
      return fixture.cache.restore(input);
    },
    save: (input: { key: string; storePath: string }) => fixture.cache.save(input),
  };
  for (const temporaryHome of ['review-a/codex', 'review-b/codex']) {
    const runner = new CodexExecRunner({
      codexHome: join(fixture.root, temporaryHome),
      executable: fixture.executable,
      dependencyDownloadCache: cache,
      dependencyDownloadCacheDirectory: publication,
    });
    expect(
      await runner.installDependencies({
        worktreePath: fixture.repo,
        cacheKey: 'acme/stable-provider-path',
      }),
    ).toMatchObject({ status: 'installed' });
  }
  expect(paths).toEqual([
    join(publication, 'npm', '_cacache'),
    join(publication, 'npm', '_cacache'),
  ]);
  expect(fixture.downloads()).toBe(1);
  expect(fixture.saved).toHaveLength(1);
  expect(fixture.saved.flat().join('\n')).not.toMatch(/node_modules|auth\.json|\.npmrc/);
}, 20_000);
