import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  type CodexOptions,
  type CopilotOptions,
  claudeCode,
  codex,
  copilot,
  cursor,
  type RunOptions,
  type RunResult,
  run,
  type SandboxProvider,
} from '@ai-hero/sandcastle';
import type { AgentDefinition } from '@sandy/shared-types';
import type { ReviewBotContext } from '../config/review-bot-context.js';

export interface AppleContainerRunnerOptions {
  readonly imageName?: string;
  readonly containerNamePrefix?: string;
  readonly mounts?: readonly {
    hostPath: string;
    sandboxPath: string;
    readonly?: boolean;
  }[];
  readonly env?: Record<string, string>;
}

export interface RunnerPullRequest {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseRef: string;
  title: string;
  url: string;
}

export interface RunnerSiblingWorktree {
  repo: string;
  sha: string;
  hostPath: string;
  sandboxPath: string;
}

export interface RunAgentInput {
  agent: AgentDefinition;
  worktreePath: string;
  pullRequest: RunnerPullRequest;
  apiSurfaceManifest?: string;
  siblingWorktrees?: readonly RunnerSiblingWorktree[];
  botConfig?: ReviewBotContext;
  signal?: AbortSignal;
}

type SandcastleRun = (options: RunOptions) => Promise<Pick<RunResult, 'stdout'>>;
type AppleContainerFactory = (
  options?: AppleContainerRunnerOptions,
) => SandboxProvider | Promise<SandboxProvider>;
type AgentProviderFactory = (agent: AgentDefinition, env: Record<string, string>) => AgentProvider;

export interface SandcastleRunnerOptions {
  /** Apple Container image tag built by `pnpm sandcastle:build-image`. */
  imageName?: string;
  /** Environment exposed to the Agent provider and sandbox. */
  env?: Record<string, string>;
  run?: SandcastleRun;
  createAppleContainer?: AppleContainerFactory;
  createAgentProvider?: AgentProviderFactory;
}

const DEFAULT_AGENT_IMAGE = 'sandy-agent';
const OPEN_SRC_SANDBOX_CACHE = '/home/agent/.opensrc';
const CODEX_AUTH_SANDBOX_PATH = '/home/agent/.codex/auth.json';
const CODEX_AUTH_STAGE_DIR = join(homedir(), '.sandy', 'codex');
const CODEX_AUTH_STAGE_FILE = join(CODEX_AUTH_STAGE_DIR, 'auth.json');
const APPLE_CONTAINER_PROVIDER_PACKAGE = '@sandy/apple-container-provider';
export const SANDY_WORKER_CONTAINER_PREFIX = 'sandy-worker-';

type AppleContainerProviderModule = {
  appleContainer: (options?: AppleContainerRunnerOptions) => SandboxProvider;
};

export class SandcastleRunner {
  readonly #imageName: string;
  readonly #env: Record<string, string>;
  readonly #run: SandcastleRun;
  readonly #createAppleContainer: AppleContainerFactory;
  readonly #createAgentProvider: AgentProviderFactory;

  constructor(options: SandcastleRunnerOptions = {}) {
    this.#imageName = options.imageName ?? DEFAULT_AGENT_IMAGE;
    this.#env = options.env ?? {};
    this.#run = options.run ?? run;
    this.#createAppleContainer = options.createAppleContainer ?? createDefaultAppleContainer;
    this.#createAgentProvider = options.createAgentProvider ?? createAgentProvider;
  }

  async runAgent(input: RunAgentInput): Promise<string> {
    const mounts: { hostPath: string; sandboxPath: string; readonly?: boolean }[] = [
      { hostPath: join(homedir(), '.opensrc'), sandboxPath: OPEN_SRC_SANDBOX_CACHE },
    ];
    for (const sibling of input.siblingWorktrees ?? []) {
      mounts.push({
        hostPath: sibling.hostPath,
        sandboxPath: sibling.sandboxPath,
        readonly: true,
      });
    }
    // Codex authenticates from the operator's host ChatGPT login. Stage a
    // world-readable copy of the credential (see stageCodexAuth) and mount only
    // that, read-only, into the Agent's CODEX_HOME — HOME is /home/agent in the
    // sandbox, so codex finds it with no extra env, and codex writes its own
    // session under the writable, container-local /home/agent/.codex.
    if (input.agent.vendor === 'codex') {
      mounts.push({
        hostPath: await stageCodexAuth(),
        sandboxPath: CODEX_AUTH_SANDBOX_PATH,
        readonly: true,
      });
    }

    const runOptions: RunOptions = {
      agent: this.#createAgentProvider(input.agent, this.#env),
      sandbox: await this.#createAppleContainer({
        imageName: this.#imageName,
        containerNamePrefix: SANDY_WORKER_CONTAINER_PREFIX,
        mounts,
        env: this.#env,
      }),
      cwd: input.worktreePath,
      prompt: buildReviewPrompt(input),
      maxIterations: input.agent.maxIterations,
      completionSignal: input.agent.completionSignal,
      branchStrategy: { type: 'head' },
      name: input.agent.key,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };

    const result = await this.#run(runOptions);

    return result.stdout;
  }
}

/**
 * Build the Sandcastle provider for an Agent's vendor/model/effort selection.
 * An absent `effort` passes no option, so the vendor CLI default applies. The
 * codex/copilot casts narrow the cross-vendor `AgentEffort` union to each
 * provider's own vocabulary — safe because the config loader validates effort
 * per vendor at startup. Cursor takes no effort; validation keeps a cursor
 * Agent from ever carrying one.
 */
export function createAgentProvider(
  agent: AgentDefinition,
  env: Record<string, string>,
): AgentProvider {
  switch (agent.vendor) {
    case 'claude':
      return claudeCode(agent.model, {
        env,
        ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
      });
    case 'codex':
      return codex(agent.model, {
        env,
        ...(agent.effort !== undefined
          ? { effort: agent.effort as NonNullable<CodexOptions['effort']> }
          : {}),
      });
    case 'cursor':
      return cursor(agent.model, { env });
    case 'copilot':
      return copilot(agent.model, {
        env,
        ...(agent.effort !== undefined
          ? { effort: agent.effort as NonNullable<CopilotOptions['effort']> }
          : {}),
      });
  }
}

/**
 * Stage the host's Codex credential for read-only bind-mounting into the Agent
 * sandbox, and return the staged file's path.
 *
 * Apple Container maps a bind-mounted host file to `root:root` inside the VM, so
 * the non-root `agent` user can only read it when it is world-readable (mode
 * 0644). Rather than relax permissions on the operator's real
 * `~/.codex/auth.json` (codex keeps it 0600), we copy it to a Sandy-owned
 * staging file: the copy is 0644 so the container can read it, but it lives in a
 * 0700 directory so other host users still cannot reach it. The operator's real
 * ~/.codex is only ever read, never modified; re-copying on every run picks up a
 * host `codex login` token refresh.
 */
async function stageCodexAuth(): Promise<string> {
  const source = join(homedir(), '.codex', 'auth.json');
  try {
    await mkdir(CODEX_AUTH_STAGE_DIR, { recursive: true });
    await chmod(CODEX_AUTH_STAGE_DIR, 0o700);
    await copyFile(source, CODEX_AUTH_STAGE_FILE);
    await chmod(CODEX_AUTH_STAGE_FILE, 0o644);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Codex Agent requires a host Codex login at ${source}, but staging it failed: ${detail}. Run \`codex login\` on the host.`,
    );
  }
  return CODEX_AUTH_STAGE_FILE;
}

async function createDefaultAppleContainer(
  options?: AppleContainerRunnerOptions,
): Promise<SandboxProvider> {
  const { appleContainer } = (await import(
    APPLE_CONTAINER_PROVIDER_PACKAGE
  )) as AppleContainerProviderModule;
  return appleContainer(options);
}

export function buildReviewPrompt(input: RunAgentInput): string {
  const pr = input.pullRequest;
  const siblingContext =
    input.siblingWorktrees === undefined || input.siblingWorktrees.length === 0
      ? ''
      : `
Sibling Repo mounts:
${input.siblingWorktrees
  .map((sibling) => `- ${sibling.sandboxPath} -> ${sibling.repo} @ ${sibling.sha}`)
  .join('\n')}
`;
  const manifestContext =
    input.apiSurfaceManifest === undefined
      ? ''
      : `
API Surface Manifest context:
Use this manifest as a trigger for Cross-Repo Search. It lists public surface and framework versions only; it does not enumerate callers.

${input.apiSurfaceManifest.trim()}
`;
  return `${input.agent.systemPrompt}

Review PR #${pr.number}: ${pr.title}

Repository: ${pr.owner}/${pr.repo}
PR URL: ${pr.url}
Base ref: ${pr.baseRef}
Head SHA: ${pr.headSha}
${siblingContext}
${manifestContext}
${formatReviewBotContext(input.botConfig)}
${formatAgentPriorContract()}
${formatSourceVerificationContract(input.agent)}

Cross-Repo Search contract:
- The reviewed Repo (${pr.owner}/${pr.repo}) is your current working directory. Sibling Repos, when present, are mounted read-only at the paths listed above; each mount maps to the shown owner/name Repo at its recorded default-branch SHA.
- Primary trigger: run Cross-Repo Search when the PR diff changes, removes, or adds a public-surface item listed in the API Surface Manifest. Include old deleted names from the diff, because the Manifest is built at the PR head and may only list the new surface.
- Secondary diff-judgment trigger: run targeted Cross-Repo Search when the diff is likely to affect a sibling Repo's behavior or assumptions even if the Manifest does not model it, including auth, routes, data shape or semantics, events, config, permissions, storage paths, generated artifacts, and shared conventions.
- Skip Cross-Repo Search for CSS-only, test-only, or otherwise local-only changes unless the diff suggests a cross-repo contract risk.
- Search siblings with rg/read_file against the mounted code, not from the Manifest alone. Confirm each hit is a real usage: resolved import, actual call site, or key lookup. Use tree_sitter_query for structural confirmation when a symbol is too generic to grep safely. Never report coincidental string matches.
- Emit one Finding per changed contract item and put all confirmed sibling consumers in crossRepoReferences; do not emit one Finding per reference. Let severity reflect the true confirmed consumer count even if the rendered reference list is later capped. Frame these as cross-repo contract drift judged against sibling main/default branch. This rule is symmetric: producer-side removals/renames and consumer-side use of symbols absent from sibling main can both be Findings.
- Always fill crossRepoSearch in the JSON output: say why you searched siblings, or say that no cross-repo contract risk was detected.
- \`status\` and \`trigger\` are a matched pair, not independent fields: a skip is exactly \`{"status":"skipped","trigger":"none"}\`; a search is \`"status":"searched"\` with \`"trigger":"manifest"\` or \`"diff-judgment"\` (never \`"none"\`).

You are running inside the checked-out PR worktree. Review the diff and emit exactly one JSON object inside <findings>...</findings>. Each finding must use an in-diff "anchor"; use "crossRepoReferences" only for confirmed affected sibling-Repo consumers:

<findings>
{
  "summary": "Optional one-paragraph review summary",
  "crossRepoSearch": {
    "status": "searched" | "skipped",
    "trigger": "manifest" | "diff-judgment" | "none",
    "rationale": "Why you searched sibling Repos, or why no cross-repo contract risk was detected.",
    "searchedRepos": ["owner/name"]
  },
  "findings": [
    {
      "severity": "P0" | "P1" | "P2",
      "confidence": 0,
      "agentKey": "<your agent key>",
      "anchor": { "repo": "owner/name", "path": "relative/path/from/repo/root.ts", "lineStart": 42, "lineEnd": 45 },
      "crossRepoReferences": [{ "repo": "owner/sibling-repo", "path": "relative/path.ts", "line": 31 }],
      "summary": "One sentence describing the issue",
      "evidence": "Why this is an issue, with code quotes or rg results",
      "suggestedFix": "Optional: how to fix",
      "category": "<your category>"
    }
  ]
}
</findings>

The finding above is an illustrative shape, not a real finding. "anchor" is REQUIRED on every finding and must be an object with repo/path/lineStart/lineEnd on an in-diff line. Omit "crossRepoReferences" unless you confirmed affected sibling-Repo consumers. Emit "findings": [] when you find nothing.
`;
}

function formatAgentPriorContract(): string {
  return `

Agent priors and active Rules:
- Treat Agent-specific examples in the system prompt as non-exhaustive seed knowledge, not as a complete checklist.
- Product Rules and Repo-local Rules in this prompt are active, version-controlled instructions for this Review. If an active Rule conflicts with a seed example, follow the Rule.
- If a Rule and a seed example point at the same issue, emit at most one Finding and cite the strongest concrete evidence.`;
}

function formatSourceVerificationContract(agent: AgentDefinition): string {
  if (!agent.tools.includes('opensrc')) {
    return '';
  }

  return `

Framework source verification:
- Do not fetch dependency source preemptively. First inspect the diff, local code, ApiSurfaceManifest, and available local types/config.
- Before emitting a Finding whose correctness depends on framework or library behavior, verify that behavior against the installed version's source with opensrc. Local types/config can guide the search, but training memory or type-shape guesses do not prove runtime behavior.
- Useful pattern: run \`opensrc path <package>\`, then search the returned source path for the touched API or symbol with \`rg\`.
- Record the verification in the Finding.evidence: package name, installed version from the ApiSurfaceManifest when available, source path or symbol inspected, and the behavior confirmed.
- Memory or generic training knowledge is not evidence for a framework-behavior claim. If installed source contradicts the suspicion, or you cannot verify enough for the Finding's confidence, suppress the Finding.`;
}

function formatReviewBotContext(config: ReviewBotContext | undefined): string {
  if (config === undefined) {
    return '';
  }

  const sections: string[] = [];
  if (config.productRules !== null) {
    sections.push(`## Product Rules

Rules from .bot/product-rules.md across this Product:

${config.productRules}`);
  }
  if (config.repoRules !== null) {
    sections.push(`## Repo-local Rules

Rules from .bot/rules.md for only this Repo:

${config.repoRules}`);
  }
  if (config.ignorePatterns.length > 0) {
    sections.push(`## Ignored Diff Paths

Files matching these .bot/ignore.gitignore patterns are excluded from Sandy's review diff. Do not review changes whose paths match them:

${config.ignorePatterns.map((pattern) => `- ${pattern}`).join('\n')}

If a diff tool still displays an ignored path, disregard that file's hunks.`);
  }

  return sections.length === 0 ? '' : `\n\n${sections.join('\n\n')}`;
}
