import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGitHubDependencyDownloadCache } from '../packages/bot-worker/dist/worker/github-dependency-download-cache.js';

if (!process.env.RUNNER_TEMP || !process.env.GITHUB_RUN_ID || !process.env.GITHUB_RUN_ATTEMPT)
  throw new Error('The cache provider probe requires a GitHub Actions runner');

// A single harmless content-addressed download fixture; never auth, source or installed trees.
const storePath = join(process.env.RUNNER_TEMP, 'sandy-download-cache-probe');
const bytes = Buffer.from('Sandy reviewed-download cache provider fixture\n');
const digest = createHash('sha512').update(bytes).digest('hex');
const contentPath = join(
  storePath,
  'content-v2',
  'sha512',
  digest.slice(0, 2),
  digest.slice(2, 4),
  digest.slice(4),
);
const key = `sandy-provider-probe-v1-${process.platform}-${process.arch}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const cache = createGitHubDependencyDownloadCache();
try {
  await rm(storePath, { recursive: true, force: true });
  await mkdir(dirname(contentPath), { recursive: true });
  await writeFile(contentPath, bytes);
  await cache.save({ key, storePath });
  await rm(storePath, { recursive: true, force: true });
  await mkdir(storePath);
  assert.equal(
    await cache.restore({ key, storePath }),
    key,
    'The actual cache service must restore the published key',
  );
  assert.deepEqual(await readFile(contentPath), bytes);
  assert.equal(
    (await readdir(storePath, { recursive: true })).filter((name) => !name.includes('/')).length,
    1,
  );
  console.info(
    'Dependency cache provider: bounded save/remove/restore passed with identical download bytes.',
  );
} finally {
  await rm(storePath, { recursive: true, force: true });
}
