import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentDefinitions } from './agents.js';

/**
 * Exercises Agent-definition loading against real markdown files on disk: the
 * default directory (`agents/`) overlaid by a per-instance override directory
 * (`.config/agents/`). Temp dirs stand in for both and are torn down after each
 * test so nothing leaks between cases or onto the real repo.
 */

const LOGIC_MD = `---
name: logic
description: Reviews diffs for logic bugs.
vendor: claude
model: opus
maxIterations: 30
completionSignal: "</findings>"
tools: [read_file, rg, git_diff]
---

# Logic Agent

Body of the logic agent prompt.
`;

const SECURITY_MD = `---
name: security
description: Reviews diffs for security issues.
vendor: claude
model: opus
maxIterations: 25
completionSignal: "</findings>"
tools: [read_file, rg]
defaultEnabled: auto
---

# Security Agent

Body of the security agent prompt.
`;

let defaultsDir: string;
let overridesDir: string;

beforeEach(() => {
  defaultsDir = mkdtempSync(join(tmpdir(), 'sandy-agents-default-'));
  overridesDir = mkdtempSync(join(tmpdir(), 'sandy-agents-override-'));
});

afterEach(() => {
  rmSync(defaultsDir, { recursive: true, force: true });
  rmSync(overridesDir, { recursive: true, force: true });
});

function write(dir: string, file: string, contents: string): void {
  writeFileSync(join(dir, file), contents);
}

describe('loadAgentDefinitions', () => {
  it('parses frontmatter and body into an AgentDefinition keyed by file name', async () => {
    write(defaultsDir, 'logic.md', LOGIC_MD);

    const agents = await loadAgentDefinitions(defaultsDir);

    const logic = agents.get('logic');
    expect(logic).toBeDefined();
    expect(logic?.key).toBe('logic');
    expect(logic?.name).toBe('logic');
    expect(logic?.description).toBe('Reviews diffs for logic bugs.');
    expect(logic?.vendor).toBe('claude');
    expect(logic?.model).toBe('opus');
    expect(logic?.maxIterations).toBe(30);
    expect(logic?.completionSignal).toBe('</findings>');
    expect(logic?.tools).toEqual(['read_file', 'rg', 'git_diff']);
    // No frontmatter `defaultEnabled` => defaults to true.
    expect(logic?.defaultEnabled).toBe(true);
    // `category` defaults to the key.
    expect(logic?.category).toBe('logic');
    expect(logic?.systemPrompt).toContain('# Logic Agent');
    expect(logic?.systemPrompt).toContain('Body of the logic agent prompt.');
    // Frontmatter is stripped from the system prompt body.
    expect(logic?.systemPrompt).not.toContain('vendor: claude');
  });

  it('preserves an explicit `defaultEnabled: auto`', async () => {
    write(defaultsDir, 'security.md', SECURITY_MD);

    const agents = await loadAgentDefinitions(defaultsDir);

    expect(agents.get('security')?.defaultEnabled).toBe('auto');
  });

  it('ignores non-markdown files in the defaults directory', async () => {
    write(defaultsDir, 'logic.md', LOGIC_MD);
    write(defaultsDir, 'README.txt', 'not an agent');
    write(defaultsDir, '.DS_Store', 'junk');

    const agents = await loadAgentDefinitions(defaultsDir);

    expect([...agents.keys()]).toEqual(['logic']);
  });

  it('overlays an override directory: same file name overrides by key', async () => {
    write(defaultsDir, 'logic.md', LOGIC_MD);
    write(overridesDir, 'logic.md', LOGIC_MD.replace('model: opus', 'model: haiku'));

    const agents = await loadAgentDefinitions(defaultsDir, overridesDir);

    expect(agents.get('logic')?.model).toBe('haiku');
    expect(agents.size).toBe(1);
  });

  it('overlays an override directory: a new file name adds an Agent', async () => {
    write(defaultsDir, 'logic.md', LOGIC_MD);
    write(overridesDir, 'custom.md', LOGIC_MD.replace('name: logic', 'name: custom'));

    const agents = await loadAgentDefinitions(defaultsDir, overridesDir);

    expect([...agents.keys()].sort()).toEqual(['custom', 'logic']);
    expect(agents.get('custom')?.name).toBe('custom');
    expect(agents.get('logic')?.model).toBe('opus');
  });

  it('tolerates a missing override directory (loads defaults only)', async () => {
    write(defaultsDir, 'logic.md', LOGIC_MD);
    const missing = join(overridesDir, 'does-not-exist');

    const agents = await loadAgentDefinitions(defaultsDir, missing);

    expect([...agents.keys()]).toEqual(['logic']);
  });

  it('throws a clear error when the defaults directory is missing', async () => {
    const missing = join(defaultsDir, 'nope');

    await expect(loadAgentDefinitions(missing)).rejects.toThrow(/agent directory/i);
  });

  it('throws a clear error naming the file when frontmatter is absent', async () => {
    write(defaultsDir, 'broken.md', '# No frontmatter here\n');

    await expect(loadAgentDefinitions(defaultsDir)).rejects.toThrow(/broken\.md/);
  });

  it('throws a clear error naming the file and field on an invalid vendor', async () => {
    write(defaultsDir, 'logic.md', LOGIC_MD.replace('vendor: claude', 'vendor: bogus'));

    await expect(loadAgentDefinitions(defaultsDir)).rejects.toThrow(/logic\.md/);
    await expect(loadAgentDefinitions(defaultsDir)).rejects.toThrow(/vendor/i);
  });

  it('throws when a required frontmatter field is missing', async () => {
    const noModel = LOGIC_MD.replace('model: opus\n', '');

    write(defaultsDir, 'logic.md', noModel);

    await expect(loadAgentDefinitions(defaultsDir)).rejects.toThrow(/model/i);
  });

  it('reads nested override directories created at runtime', async () => {
    // Guards that the loader uses the directory it is given, not a hard-coded path.
    const nested = join(overridesDir, 'instance', 'agents');
    await mkdir(nested, { recursive: true });
    write(defaultsDir, 'logic.md', LOGIC_MD);
    write(nested, 'logic.md', LOGIC_MD.replace('model: opus', 'model: sonnet'));

    const agents = await loadAgentDefinitions(defaultsDir, nested);

    expect(agents.get('logic')?.model).toBe('sonnet');
  });

  it('derives the key case-insensitively, so a `.MD` override replaces a default', async () => {
    write(defaultsDir, 'logic.md', LOGIC_MD);
    // The directory filter accepts `.md` case-insensitively, so the key strip
    // must too — otherwise this override would add a second Agent instead of
    // replacing `logic` by key (ADR 0006 override-by-file-name).
    write(overridesDir, 'logic.MD', LOGIC_MD.replace('model: opus', 'model: haiku'));

    const agents = await loadAgentDefinitions(defaultsDir, overridesDir);

    expect(agents.size).toBe(1);
    expect(agents.get('logic')?.model).toBe('haiku');
  });

  it('trims surrounding whitespace from frontmatter string fields', async () => {
    write(defaultsDir, 'logic.md', LOGIC_MD.replace('model: opus', 'model: "  opus  "'));

    const agents = await loadAgentDefinitions(defaultsDir);

    expect(agents.get('logic')?.model).toBe('opus');
  });
});
