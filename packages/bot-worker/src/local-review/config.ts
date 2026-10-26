import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConfigLoader } from '../config/loader.js';
import { defaultConfigLoaderOptions } from '../config/paths.js';
import { LocalReviewInputError } from './errors.js';
import { originDefaultBranch, type RemoteRepository, type ReviewBase } from './git.js';
import { type LocalReviewHome, pathExists, removeTree } from './home.js';

/** Matches the GitHub Action's default `model` input. */
export const DEFAULT_LOCAL_REVIEW_MODEL = 'gpt-6.1-sol';

export interface LocalReviewConfig {
  loader: ConfigLoader;
  /** Where the Product configuration came from, for the run log. */
  source: string;
  /** The operator's config file; the Agent sandbox must not read it. */
  configPath?: string;
}

export interface LocalReviewConfigInput {
  sandyRoot: string;
  home: LocalReviewHome;
  repo: RemoteRepository;
  checkoutRoot: string;
  base: ReviewBase;
  /** `--config` or `SANDY_CONFIG_PATH`. */
  configPath?: string;
}

/**
 * Use an explicit config, then the Sandy checkout's `.config/bot.yaml` when it
 * lists the Repo, and otherwise the single-Repo Product the GitHub Action
 * generates when it has no `config-path`.
 */
export async function loadLocalReviewConfig(
  input: LocalReviewConfigInput,
): Promise<LocalReviewConfig> {
  const options = defaultConfigLoaderOptions(input.sandyRoot);
  const fullName = `${input.repo.owner}/${input.repo.name}`;
  if (input.configPath !== undefined) {
    const configPath = resolve(input.configPath);
    const loader = await ConfigLoader.create({ ...options, botYamlPath: configPath });
    if (loader.resolveForRepo(input.repo.owner, input.repo.name) === null) {
      throw new LocalReviewInputError(`${fullName} is not a Repo in ${configPath}`);
    }
    return { loader, source: configPath, configPath };
  }
  if (await pathExists(options.botYamlPath)) {
    const loader = await ConfigLoader.create(options);
    if (loader.resolveForRepo(input.repo.owner, input.repo.name) !== null) {
      return { loader, source: options.botYamlPath, configPath: options.botYamlPath };
    }
  }
  const defaultBranch =
    (await originDefaultBranch(input.checkoutRoot)) ??
    (input.base.label.startsWith('origin/') ? input.base.label.slice('origin/'.length) : 'main');
  const directory = await mkdtemp(join(input.home.root, 'config-'));
  try {
    const botYamlPath = join(directory, 'bot.yaml');
    await writeFile(botYamlPath, generatedBotYaml(input.repo, defaultBranch), { mode: 0o600 });
    return {
      loader: await ConfigLoader.create({ ...options, botYamlPath }),
      source: 'the GitHub Action defaults (logic, security, convex)',
    };
  } finally {
    await removeTree(directory);
  }
}

/** JSON is valid YAML; the Action serializes the same shape for its default config. */
export function generatedBotYaml(repo: RemoteRepository, defaultBranch: string): string {
  const runtime = { vendor: 'codex', model: DEFAULT_LOCAL_REVIEW_MODEL, effort: 'xhigh' };
  return `${JSON.stringify(
    {
      products: [
        {
          slug: productSlug(repo.name),
          name: repo.name,
          repos: [{ owner: repo.owner, name: repo.name, defaultBranch }],
          agents: {
            enable: ['logic', 'security', 'convex'],
            overrides: { logic: runtime, security: runtime, convex: runtime },
          },
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function productSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  return slug === '' ? 'local' : slug;
}
