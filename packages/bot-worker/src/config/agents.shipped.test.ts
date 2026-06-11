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

const RTK_TRIAL_AGENT_KEY = 'test-coverage';
const RTK_PROMPT_REFERENCE = /\brtk\b/i;
const RTK_PROMPT_CONTRACT = [
  '## Tool Output',
  'When `rtk` is available, prefix test/log-producing shell commands with it',
  'If `rtk` is not available, run the same commands normally',
  'Never use `rtk` on `git diff` or anywhere exact untransformed output matters',
] as const;

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
    expect(logic.tools.length).toBeGreaterThan(0);
    expect(logic.systemPrompt.length).toBeGreaterThan(0);
    // Each definition carries the required fields.
    for (const agent of agents.values()) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.model.length).toBeGreaterThan(0);
      expect(agent.maxIterations).toBeGreaterThan(0);
    }
  });

  it('ships RTK guidance in the test-coverage Agent without changing its runtime contract', async () => {
    const agents = await loadAgentDefinitions(shippedAgentsDir);
    const testCoverage = requireAgent(agents, RTK_TRIAL_AGENT_KEY);

    expect(testCoverage.vendor).toBe('claude');
    expect(testCoverage.model).toBe('haiku');
    expect(testCoverage.maxIterations).toBe(15);
    expect(testCoverage.tools).toEqual(['read_file', 'rg', 'git_diff']);
    for (const expectedText of RTK_PROMPT_CONTRACT) {
      expect(testCoverage.systemPrompt).toContain(expectedText);
    }
  });

  it('keeps RTK guidance scoped to the test-coverage Agent', async () => {
    const agents = await loadAgentDefinitions(shippedAgentsDir);
    const agentsMentioningRtk = Array.from(agents.values())
      .filter((agent) => RTK_PROMPT_REFERENCE.test(agent.systemPrompt))
      .map((agent) => agent.key);

    expect(agentsMentioningRtk).toEqual([RTK_TRIAL_AGENT_KEY]);
  });
});

function requireAgent(agents: ReadonlyMap<string, AgentDefinition>, key: string): AgentDefinition {
  const agent = agents.get(key);
  if (agent === undefined) {
    throw new Error(`Expected shipped Agent ${key}`);
  }
  return agent;
}
