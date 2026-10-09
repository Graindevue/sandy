import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDefinition } from '@sandy/shared-types';
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
    const logic = requireAgent(agents, 'logic');
    expect(logic.vendor).toBe('codex');
    expect(logic.systemPrompt.length).toBeGreaterThan(0);
    // Each definition carries the required fields.
    for (const agent of agents.values()) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.model).toBe('gpt-6.1-sol');
      expect(agent.effort).toBe('xhigh');
      expect(agent.vendor).toBe('codex');
      expect(agent.tools).toBeUndefined();
      expect(agent.maxIterations).toBeUndefined();
    }
  });

  it('keeps specialized optional agents disabled and Convex conditional', async () => {
    const agents = await loadAgentDefinitions(shippedAgentsDir);
    expect(requireAgent(agents, 'logic').effort).toBe('xhigh');
    expect(requireAgent(agents, 'security').effort).toBe('xhigh');
    expect(requireAgent(agents, 'convex').defaultEnabled).toBe('auto');
    for (const key of ['test-coverage', 'style', 'nextjs', 'i18n']) {
      expect(requireAgent(agents, key).defaultEnabled).toBe(false);
    }
  });
});

function requireAgent(agents: ReadonlyMap<string, AgentDefinition>, key: string): AgentDefinition {
  const agent = agents.get(key);
  if (agent === undefined) {
    throw new Error(`Expected shipped Agent ${key}`);
  }
  return agent;
}
