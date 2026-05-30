import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAgentDefinitions } from './agents.js';

/**
 * Loads the Agent definitions Sandy actually ships (`agents/*.md` at the repo
 * root) through the real parser. Guards that every shipped Agent file's
 * frontmatter satisfies the loader's schema — a malformed default would
 * otherwise only surface at worker startup.
 */

// packages/bot-worker/src/config/ -> repo root is four levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shippedAgentsDir = join(repoRoot, 'agents');

describe('shipped agents/', () => {
  it('every shipped Agent file loads and includes the logic Agent', async () => {
    const onDisk = (await readdir(shippedAgentsDir)).filter((f) => f.endsWith('.md'));
    expect(onDisk.length).toBeGreaterThan(0);

    const agents = await loadAgentDefinitions(shippedAgentsDir);

    // Every shipped `.md` parsed into a definition.
    expect(agents.size).toBe(onDisk.length);
    // Phase 1's active Agent is present and well-formed.
    const logic = agents.get('logic');
    expect(logic?.vendor).toBe('codex');
    expect(logic?.tools.length).toBeGreaterThan(0);
    expect(logic?.systemPrompt.length).toBeGreaterThan(0);
    // Each definition carries the required fields.
    for (const agent of agents.values()) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.model.length).toBeGreaterThan(0);
      expect(agent.maxIterations).toBeGreaterThan(0);
    }
  });
});
