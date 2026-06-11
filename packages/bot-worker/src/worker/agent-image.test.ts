import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const agentImageDockerfile = join(repoRoot, 'images', 'agent', 'Dockerfile');

describe('agent image Dockerfile', () => {
  it('ships RTK without changing the agent base image', async () => {
    const dockerfile = await readFile(agentImageDockerfile, 'utf8');

    expect(dockerfile).toContain('FROM node:24-bookworm');
    expect(dockerfile).not.toContain('trixie');
    expect(dockerfile).toContain('AS rtk-builder');
    expect(dockerfile).toContain('rtk --version');
  });
});
