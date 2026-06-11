import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const agentImageDockerfile = join(repoRoot, 'images', 'agent', 'Dockerfile');

describe('agent image Dockerfile', () => {
  it('keeps RTK available on the arm64 Apple Container path', async () => {
    const dockerfile = await readFile(agentImageDockerfile, 'utf8');

    expect(dockerfile).toContain('FROM node:24-trixie');
    expect(dockerfile).toContain('aarch64-unknown-linux-gnu');
    expect(dockerfile).toContain('rtk --version');
  });
});
