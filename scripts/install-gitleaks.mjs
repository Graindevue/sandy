import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Checksums from the official v8.30.1 release's checksums.txt. Keep the version
// and checksums together so a changed release asset cannot silently execute.
const version = '8.30.1';
const checksums = {
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
const platform = `${process.platform}_${process.arch}`;
const checksum = checksums[platform];
if (!checksum) throw new Error(`Unsupported Gitleaks platform: ${platform}`);

const archiveName = `gitleaks_${version}_${platform}.tar.gz`;
const url = `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archiveName}`;
const scratch = await mkdtemp(join(tmpdir(), 'sandy-gitleaks-'));
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Gitleaks download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== checksum) {
    throw new Error('Gitleaks download checksum mismatch; refusing to install');
  }
  const archivePath = join(scratch, archiveName);
  await writeFile(archivePath, archive, { mode: 0o600 });
  execFileSync('tar', ['-xzf', archivePath, '-C', scratch, 'gitleaks']);
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const tools = join(root, '.sandy', 'tools');
  await mkdir(tools, { recursive: true, mode: 0o700 });
  const destination = join(tools, 'gitleaks');
  await copyFile(join(scratch, 'gitleaks'), destination);
  await chmod(destination, 0o755);
  console.info(`Installed checksum-verified Gitleaks ${version} in .sandy/tools`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
