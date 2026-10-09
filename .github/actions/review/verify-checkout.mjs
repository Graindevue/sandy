import { execFileSync } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function assertNoPrivateKeys(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoPrivateKeys(path);
    } else if (entry.isFile()) {
      const file = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (
          /-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)?\s*PRIVATE KEY-----/.test(
            buffer.toString('utf8', 0, bytesRead),
          )
        ) {
          throw new Error(
            'Checkout left a private key in RUNNER_TEMP; refusing to run reviewed code',
          );
        }
      } finally {
        await file.close();
      }
    }
  }
}

if (process.argv[1]?.endsWith('/verify-checkout.mjs')) {
  const workspace = process.env.GITHUB_WORKSPACE;
  const temporary = process.env.RUNNER_TEMP;
  if (!workspace || !temporary) throw new Error('Checkout verification requires Actions paths');
  try {
    const credentials = execFileSync(
      'git',
      [
        '-C',
        join(workspace, 'sandy'),
        'config',
        '--local',
        '--get-regexp',
        '^(core\\.sshcommand|http\\..*\\.extraheader)$',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (credentials.trim()) throw new Error('Checkout left git authentication configured');
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  await assertNoPrivateKeys(temporary);
}
