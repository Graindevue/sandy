import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConfigLoaderOptions } from './loader.js';

/**
 * Where the config layer reads from and writes clones to, by default. Centralizes
 * the layout from ADR 0006 (`agents/` defaults + `.config/` per-instance) so the
 * worker entry point and operators share one source of truth.
 */

/**
 * Default {@link ConfigLoaderOptions} for a Sandy checkout at `repoRoot`: defaults
 * in `<repoRoot>/agents`, per-instance overrides in `<repoRoot>/.config/agents`,
 * and `bot.yaml` at `<repoRoot>/.config/bot.yaml`.
 */
export function defaultConfigLoaderOptions(repoRoot: string): Required<ConfigLoaderOptions> {
  return {
    botYamlPath: join(repoRoot, '.config', 'bot.yaml'),
    agentsDir: join(repoRoot, 'agents'),
    overridesDir: join(repoRoot, '.config', 'agents'),
  };
}

/**
 * Base directory for Repo clones and per-Review worktrees. Set `SANDY_CLONE_DIR`
 * to override; otherwise defaults to `~/.sandy/repos`. Deliberately OUTSIDE the
 * Sandy repo so clones are never mistaken for repo content (the in-repo fallback,
 * if ever used, is gitignored — see `.gitignore`).
 */
export function defaultCloneBaseDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SANDY_CLONE_DIR;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return join(homedir(), '.sandy', 'repos');
}
