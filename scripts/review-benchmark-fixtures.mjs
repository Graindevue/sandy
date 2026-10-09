import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ZOD_VERSION = '4.1.12';
const PORT = 47843;

/** Authored code fixtures plus one actual version-pinned framework download. */
export async function prepareBenchmarkFixtures(root) {
  const metadata = await fetch(`https://registry.npmjs.org/zod/${ZOD_VERSION}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!metadata.ok) throw new Error('Could not retrieve pinned Zod metadata');
  const packageMetadata = await metadata.json();
  if (
    packageMetadata.version !== ZOD_VERSION ||
    Object.keys(packageMetadata.dependencies ?? {}).length > 0
  )
    throw new Error('Unexpected pinned dependency graph');
  const response = await fetch(`https://registry.npmjs.org/zod/-/zod-${ZOD_VERSION}.tgz`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('Could not retrieve pinned Zod tarball');
  const tarball = Buffer.from(await response.arrayBuffer());
  if (tarball.length > 5_000_000) throw new Error('Fixture dependency exceeded size bound');
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (integrity !== packageMetadata.dist.integrity)
    throw new Error('Pinned framework integrity mismatch');
  let downloads = { requests: 0, bytes: 0 };
  const source = createServer((request, response) => {
    if (request.url !== '/zod.tgz') {
      response.writeHead(404).end();
      return;
    }
    downloads.requests++;
    downloads.bytes += tarball.length;
    response
      .writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': tarball.length,
      })
      .end(tarball);
  });
  await new Promise((resolve, reject) => {
    source.once('error', reject);
    source.listen(PORT, '127.0.0.1', resolve);
  });
  try {
    const producer = join(root, 'producer');
    const consumer = join(root, 'consumer');
    const { stdout: npmVersion } = await exec('npm', ['--version'], { timeout: 10_000 });
    const packageManager = `npm@${npmVersion.trim()}`;
    for (const directory of [producer, consumer]) await mkdir(directory, { recursive: true });
    await writeFile(
      join(producer, 'package.json'),
      `${JSON.stringify({ name: '@evaluation/producer', version: '1.0.0', private: true, packageManager, main: 'ledger.cjs', dependencies: { zod: `http://127.0.0.1:${PORT}/zod.tgz` }, scripts: { test: 'node --test ledger.test.cjs' } }, null, 2)}\n`,
    );
    await writeFile(
      join(producer, 'package-lock.json'),
      `${JSON.stringify({ name: '@evaluation/producer', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: '@evaluation/producer', version: '1.0.0', dependencies: { zod: `http://127.0.0.1:${PORT}/zod.tgz` } }, 'node_modules/zod': { version: ZOD_VERSION, resolved: `http://127.0.0.1:${PORT}/zod.tgz`, integrity, license: 'MIT' } } }, null, 2)}\n`,
    );
    await writeFile(join(producer, '.gitignore'), 'node_modules/\ndist/\n.sandy-tools/\n');
    const baseline = `// All authenticated users can reach request(); authorization belongs here.
function transfer(balance, amount) {
  if (!Number.isFinite(amount) || amount <= 0 || amount > balance) throw new Error('invalid transfer');
  return balance - amount;
}
function purgeAllTenants(session, ledger) {
  if (session.role !== 'operator') throw new Error('operator required');
  ledger.clear();
}
function formatReceipt(id) { return 'receipt:' + id; }
module.exports = { transfer, purgeAllTenants, formatReceipt };
`;
    await writeFile(join(producer, 'ledger.cjs'), baseline);
    await writeFile(
      join(producer, 'request.cjs'),
      `const { transfer, purgeAllTenants } = require('./ledger.cjs');
const { profile } = require('./profile.cjs');
// session comes from authenticated server middleware; members are not operators.
exports.request = (session, body, ledger) => {
  if (body.action === 'purge') return purgeAllTenants(session, ledger);
  if (body.action === 'transfer') return transfer(body.balance, body.amount);
  if (body.action === 'profile') return profile({ id: session.id, passwordHash: session.passwordHash });
};
`,
    );
    const profile = `const { z } = require('zod');
const publicSchema = z.object({ id: z.string() });
exports.profile = (row) => publicSchema.parse(row);
`;
    await writeFile(join(producer, 'profile.cjs'), profile);
    await writeFile(
      join(producer, 'ledger.test.cjs'),
      `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transfer } = require('./ledger.cjs');
test('valid transfer', () => assert.equal(transfer(100, 10), 90));
`,
    );
    await writeFile(join(producer, 'logger.cjs'), `exports.label = 'ledger request';\n`);
    await initializeRepository(producer);
    const baseSha = await commit(producer, 'baseline');
    await exec('git', ['-C', producer, 'branch', 'baseline', baseSha]);
    await writeFile(
      join(producer, 'ledger.cjs'),
      baseline
        .replace('!Number.isFinite(amount) || amount <= 0 || ', '')
        .replace("  if (session.role !== 'operator') throw new Error('operator required');\n", '')
        .replaceAll('formatReceipt', 'formatReceiptV2'),
    );
    await writeFile(
      join(producer, 'profile.cjs'),
      profile.replace('z.object({ id: z.string() })', 'z.object({ id: z.string() }).passthrough()'),
    );
    const defectSha = await commit(producer, 'defects');
    await exec('git', ['-C', producer, 'switch', '-c', 'clean', baseSha]);
    await writeFile(join(producer, 'logger.cjs'), `exports.label = 'ledger operation';\n`);
    const cleanSha = await commit(producer, 'clean wording');
    await exec('git', ['-C', producer, 'switch', 'main']);
    await writeFile(
      join(consumer, 'package.json'),
      `${JSON.stringify({ name: '@evaluation/consumer', private: true, dependencies: { '@evaluation/producer': '1.0.0' } }, null, 2)}\n`,
    );
    await writeFile(
      join(consumer, 'receipt.cjs'),
      `const { formatReceipt } = require('@evaluation/producer');\nexports.receipt = (id) => formatReceipt(id);\n`,
    );
    await initializeRepository(consumer);
    const siblingSha = await commit(consumer, 'pinned receipt consumer');
    const common = {
      origin: producer,
      repo: { owner: 'evaluation', name: 'producer', defaultBranch: 'main' },
      baseSha,
      packageManager,
      sibling: {
        origin: consumer,
        repo: { owner: 'evaluation', name: 'consumer', defaultBranch: 'main' },
        sha: siblingSha,
      },
      manifest: JSON.stringify({
        repo: 'evaluation/producer',
        publicExports: ['transfer', 'purgeAllTenants', 'formatReceiptV2'],
        frameworks: [{ name: 'zod', version: ZOD_VERSION }],
        sibling: 'evaluation/consumer',
      }),
    };
    return {
      fixtures: [
        {
          ...common,
          id: 'defects',
          headSha: defectSha,
          scenarios: ['incomplete-tests', 'source-verification'],
          expected: [
            {
              id: 'negative-transfer',
              kind: 'logic',
              severity: 'P1',
              rationale:
                'Negative transfers create money; the existing test covers only positive amounts.',
            },
            {
              id: 'tenant-purge-auth',
              kind: 'security',
              severity: 'P0',
              rationale:
                'Every authenticated member can destroy every tenant ledger after the operator check is removed.',
            },
            {
              id: 'profile-secret',
              kind: 'framework',
              severity: 'P1',
              rationale:
                'Installed Zod passthrough preserves passwordHash, which the response returns.',
            },
            {
              id: 'receipt-export',
              kind: 'cross-repo',
              severity: 'P1',
              rationale: 'The pinned consumer imports and calls the removed producer export.',
            },
          ],
        },
        {
          ...common,
          id: 'clean',
          headSha: cleanSha,
          expected: [],
          manifest: common.manifest.replace('formatReceiptV2', 'formatReceipt'),
        },
      ],
      source: 'pinned official Zod tarball, served by a controlled local HTTP source',
      async persistEvidence(directory) {
        await mkdir(directory);
        await exec('git', [
          '-C',
          producer,
          'bundle',
          'create',
          join(directory, 'producer.bundle'),
          '--all',
        ]);
        await exec('git', [
          '-C',
          consumer,
          'bundle',
          'create',
          join(directory, 'consumer.bundle'),
          '--all',
        ]);
        await writeFile(join(directory, `zod-${ZOD_VERSION}.tgz`), tarball, { flag: 'wx' });
        await writeFile(
          join(directory, 'dependency.json'),
          `${JSON.stringify({ name: 'zod', version: ZOD_VERSION, integrity }, null, 2)}\n`,
          { flag: 'wx' },
        );
      },
      resetDownloads() {
        downloads = { requests: 0, bytes: 0 };
      },
      downloads() {
        return { ...downloads };
      },
      async close() {
        source.closeAllConnections();
        await new Promise((resolve) => source.close(resolve));
      },
    };
  } catch (error) {
    source.closeAllConnections();
    await new Promise((resolve) => source.close(resolve));
    throw error;
  }
}

async function initializeRepository(path) {
  await exec('git', ['init', '--initial-branch=main', path]);
}

async function commit(path, message) {
  await exec('git', ['-C', path, 'add', '.']);
  await exec(
    'git',
    [
      '-C',
      path,
      '-c',
      'user.name=Evaluation',
      '-c',
      'user.email=evaluation@example.invalid',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      message,
    ],
    {
      env: {
        PATH: process.env.PATH,
        GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
        HOME: path,
      },
    },
  );
  return (await exec('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim();
}
