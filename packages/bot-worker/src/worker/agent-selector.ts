import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDefinition } from '@sandy/shared-types';
import { parse as parseYaml } from 'yaml';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const SKIPPED_PACKAGE_DIRS = new Set([
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

const I18N_DEPENDENCIES = new Set([
  '@formatjs/cli',
  '@formatjs/intl',
  '@lingui/core',
  '@lingui/react',
  'formatjs',
  'i18next',
  'i18n-js',
  'next-intl',
  'react-i18next',
  'react-intl',
  'svelte-i18n',
  'vue-i18n',
]);

export interface AgentSelectionRepo {
  fullName: string;
  worktreePath: string;
  agentsYaml?: string | null;
}

export interface SelectAgentsForReviewInput {
  agents: readonly AgentDefinition[];
  reviewRepoFullName: string;
  productRepos: readonly AgentSelectionRepo[];
  changedPaths?: readonly string[];
}

interface AgentOverrides {
  enable: string[];
  disable: string[];
}

export async function selectAgentsForReview(
  input: SelectAgentsForReviewInput,
): Promise<AgentDefinition[]> {
  const knownAgentKeys = new Set(input.agents.map((agent) => agent.key));
  let productDependencies: Set<string> | null = null;
  const selected = new Set<string>();

  for (const agent of input.agents) {
    if (agent.defaultEnabled === true) {
      selected.add(agent.key);
      continue;
    }
    if (agent.defaultEnabled === 'auto') {
      productDependencies ??= await readProductDependencies(input.productRepos);
      if (isAutoEnabled(agent.key, productDependencies)) {
        selected.add(agent.key);
      }
    }
  }

  const overrides = await readReviewedRepoOverrides(input);
  for (const key of overrides.disable) {
    assertKnownAgent(key, knownAgentKeys, 'disable');
    selected.delete(key);
  }
  for (const key of overrides.enable) {
    assertKnownAgent(key, knownAgentKeys, 'enable');
    selected.add(key);
  }

  return input.agents.filter(
    (agent) =>
      selected.has(agent.key) &&
      (agent.key !== 'convex' ||
        input.changedPaths === undefined ||
        input.changedPaths.some((path) => /(^|\/)convex\//.test(path))),
  );
}

async function readProductDependencies(repos: readonly AgentSelectionRepo[]): Promise<Set<string>> {
  const dependencies = new Set<string>();
  await Promise.all(
    repos.map(async (repo) => {
      for (const path of await listPackageJsonFiles(repo.worktreePath)) {
        const text = await readFile(path, 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          throw new Error(`${path} is not valid JSON: ${describeError(error)}`);
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          continue;
        }
        for (const field of DEPENDENCY_FIELDS) {
          const value = (parsed as Record<string, unknown>)[field];
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            continue;
          }
          for (const packageName of Object.keys(value)) {
            dependencies.add(packageName);
          }
        }
      }
    }),
  );
  return dependencies;
}

async function listPackageJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectPackageJsonFiles(root, files);
  return files;
}

async function collectPackageJsonFiles(dir: string, files: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw new Error(`could not read ${dir}: ${describeError(error)}`);
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (!SKIPPED_PACKAGE_DIRS.has(entry.name)) {
          await collectPackageJsonFiles(join(dir, entry.name), files);
        }
        return;
      }
      if (entry.isFile() && entry.name === 'package.json') {
        files.push(join(dir, entry.name));
      }
    }),
  );
}

async function readReviewedRepoOverrides(
  input: SelectAgentsForReviewInput,
): Promise<AgentOverrides> {
  const reviewRepo = input.productRepos.find(
    (repo) => normalizeFullName(repo.fullName) === normalizeFullName(input.reviewRepoFullName),
  );
  if (reviewRepo === undefined) {
    return { enable: [], disable: [] };
  }

  const agentsYaml =
    reviewRepo.agentsYaml === undefined
      ? await readOptionalText(join(reviewRepo.worktreePath, '.bot', 'agents.yaml'))
      : reviewRepo.agentsYaml;
  return parseAgentOverrides(agentsYaml, `${reviewRepo.fullName}/.bot/agents.yaml`);
}

function parseAgentOverrides(contents: string | null, source: string): AgentOverrides {
  if (contents === null || contents.trim().length === 0) {
    return { enable: [], disable: [] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch (error) {
    throw new Error(`${source} has invalid YAML: ${describeError(error)}`);
  }
  if (parsed === null) {
    return { enable: [], disable: [] };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a YAML mapping`);
  }

  const object = parsed as Record<string, unknown>;
  const enable = parseStringList(object.enable, `${source}.enable`);
  const disable = parseStringList(object.disable, `${source}.disable`);
  const agents = object.agents;

  if (agents !== undefined) {
    if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
      throw new Error(`${source}.agents must be a mapping when present`);
    }
    const agentsObject = agents as Record<string, unknown>;
    enable.push(...parseStringList(agentsObject.enable, `${source}.agents.enable`));
    disable.push(...parseStringList(agentsObject.disable, `${source}.agents.disable`));
    for (const [key, value] of Object.entries(agentsObject)) {
      if (key === 'enable' || key === 'disable') {
        continue;
      }
      if (value === true) {
        enable.push(key);
      } else if (value === false) {
        disable.push(key);
      } else {
        throw new Error(`${source}.agents.${key} must be true or false`);
      }
    }
  }

  return { enable: unique(enable), disable: unique(disable) };
}

function parseStringList(value: unknown, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${where} must be a list of Agent keys`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function isAutoEnabled(agentKey: string, dependencies: ReadonlySet<string>): boolean {
  switch (agentKey) {
    case 'convex':
      return dependencies.has('convex');
    case 'nextjs':
      return dependencies.has('next');
    case 'i18n':
      return [...I18N_DEPENDENCIES].some((dependency) => dependencies.has(dependency));
    default:
      return dependencies.has(agentKey);
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    const trimmed = text.replace(/\r\n/g, '\n').trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw new Error(`could not read ${path}: ${describeError(error)}`);
  }
}

function assertKnownAgent(
  key: string,
  knownAgentKeys: ReadonlySet<string>,
  direction: 'enable' | 'disable',
): void {
  if (!knownAgentKeys.has(key)) {
    const known = [...knownAgentKeys].sort().join(', ');
    throw new Error(
      `.bot/agents.yaml ${direction} references unknown Agent ${JSON.stringify(key)} (known: ${known || 'none'})`,
    );
  }
}

function normalizeFullName(fullName: string): string {
  return fullName.toLowerCase();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
