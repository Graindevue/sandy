import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type AgentProvider,
  type BindMountSandboxHandle,
  type CodexOptions,
  type CopilotOptions,
  claudeCode,
  codex,
  copilot,
  cursor,
  type ExecResult,
  type IterationResult,
  type RunOptions,
  type RunResult,
  run,
  type SandboxProvider,
} from '@ai-hero/sandcastle';
import type { AgentDefinition, AgentRunUsage } from '@sandy/shared-types';
import type { ReviewBotContext } from '../config/review-bot-context.js';
import { type DependencyInstallResult, detectDependencyInstall } from './dependency-install.js';

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
  dependencyInstall?: DependencyInstallResult;
  signal?: AbortSignal;
}

export interface InstallDependenciesInput {
  worktreePath: string;
  /**
   * Stable per-Repo key (e.g. `owner/name`) for the host-side node_modules
   * seed cache. Without it the install still works but never reuses a seed.
   */
  cacheKey?: string;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  stdout: string;
  usage?: AgentRunUsage;
}

type SandcastleRun = (options: RunOptions) => Promise<Pick<RunResult, 'stdout' | 'iterations'>>;
type AppleContainerFactory = (
  options?: AppleContainerRunnerOptions,
) => SandboxProvider | Promise<SandboxProvider>;
type AgentProviderFactory = (agent: AgentDefinition, env: Record<string, string>) => AgentProvider;

export interface SandcastleRunnerOptions {
  /** Apple Container image tag built by `pnpm sandcastle:build-image`. */
  imageName?: string;
  /** Environment exposed to the Agent provider and sandbox. */
  env?: Record<string, string>;
  /** Hard cap on the once-per-Review dependency install. Default: 15 minutes. */
  installTimeoutMs?: number;
  /** Root of the per-Repo node_modules seed cache. Default: ~/.sandy/node-modules-cache. */
  nodeModulesCacheDir?: string;
  run?: SandcastleRun;
  createAppleContainer?: AppleContainerFactory;
  createAgentProvider?: AgentProviderFactory;
}

const DEFAULT_AGENT_IMAGE = 'sandy-agent';
const OPEN_SRC_SANDBOX_CACHE = '/home/agent/.opensrc';
/** Where sandcastle bind-mounts the review worktree inside every Agent VM. */
const WORKSPACE_SANDBOX_PATH = '/home/agent/workspace';
/**
 * Host-side per-Repo node_modules seed cache. Bind-mounting a persistent
 * pnpm store into the VM is unusable at real-repo scale — virtiofs per-file
 * latency means just walking graindevue's 85k-file store takes ~53s and a
 * warm install exceeded 10 minutes — so the package-manager store stays
 * VM-local and dies with the install VM. Instead, a successful install seeds
 * this cache with an APFS-clonefile copy of the worktree's node_modules, and
 * later Reviews clone it back host-side (native FS speed) before the VM
 * starts; the in-VM install then only verifies and patches lockfile drift.
 */
const NODE_MODULES_CACHE_DIR = join(homedir(), '.sandy', 'node-modules-cache');
const PNPM_STORE_SANDBOX_PATH = '/home/agent/.local/share/pnpm/store';
const SEED_COPY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * pnpm settings injected into every VM, in pnpm's snake_case env form (the
 * dashed form is silently ignored — verified against pnpm 10.34).
 *
 * - manage_package_manager_versions: pnpm 10 defaults this to true, making
 *   every invocation try to replace itself with the Repo's pinned
 *   `packageManager` version — a registry download that broke review
 *   sandboxes with "pnpm@X binary missing" (PR graindevue#236). The baked
 *   image also disables it via ~/.npmrc; the env covers stale images.
 * - store_dir: pnpm keeps one store per drive, and the bind-mounted worktree
 *   is a different device than the VM root — without the explicit VM-local
 *   path pnpm silently creates a throwaway `.pnpm-store` inside the PR
 *   worktree, littering it and dragging store I/O back onto virtiofs.
 */
const PACKAGE_MANAGER_ENV: Record<string, string> = {
  npm_config_manage_package_manager_versions: 'false',
  npm_config_store_dir: PNPM_STORE_SANDBOX_PATH,
};
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
  readonly #sandboxEnv: Record<string, string>;
  readonly #installTimeoutMs: number;
  readonly #nodeModulesCacheDir: string;
  readonly #run: SandcastleRun;
  readonly #createAppleContainer: AppleContainerFactory;
  readonly #createAgentProvider: AgentProviderFactory;

  constructor(options: SandcastleRunnerOptions = {}) {
    this.#imageName = options.imageName ?? DEFAULT_AGENT_IMAGE;
    this.#env = options.env ?? {};
    // The package-manager env rides on the sandbox provider ONLY. Sandcastle
    // rejects any key present in both the agent provider's env and the
    // sandbox provider's env (mergeProviderEnv), so adding these to the
    // shared operator env fails every Agent run at startup.
    this.#sandboxEnv = { ...PACKAGE_MANAGER_ENV, ...this.#env };
    this.#installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    this.#nodeModulesCacheDir = options.nodeModulesCacheDir ?? NODE_MODULES_CACHE_DIR;
    this.#run = options.run ?? run;
    this.#createAppleContainer = options.createAppleContainer ?? createDefaultAppleContainer;
    this.#createAgentProvider = options.createAgentProvider ?? createAgentProvider;
  }

  /**
   * Install the reviewed Repo's dependencies into the shared worktree, once
   * per Review and before the Agent fan-out. The worktree is seeded host-side
   * from the per-Repo node_modules cache when one exists, then a dedicated
   * one-shot VM (same image as the Agents) runs the lockfile-faithful install
   * — a near-no-op verification on a fresh seed. The Linux-native
   * node_modules lands in the bind-mounted worktree, visible to every Agent
   * VM. Failures are reported, not thrown — the Review degrades to static
   * analysis with a loud signal in each Agent prompt. Only an abort
   * (cancellation/supersede) propagates as a throw.
   */
  async installDependencies(input: InstallDependenciesInput): Promise<DependencyInstallResult> {
    const detected = await detectDependencyInstall(input.worktreePath);
    if (detected === null) {
      return { status: 'skipped', reason: 'no package.json or supported lockfile in the worktree' };
    }

    const seed = await seedCacheFor(
      input.worktreePath,
      input.cacheKey,
      detected.lockfile,
      this.#nodeModulesCacheDir,
    );
    if (seed !== null) {
      await seedWorktreeFromCache(seed);
    }
    const provider = await this.#createAppleContainer({
      imageName: this.#imageName,
      containerNamePrefix: SANDY_WORKER_CONTAINER_PREFIX,
      env: this.#sandboxEnv,
    });
    if (provider.tag !== 'bind-mount') {
      return {
        status: 'skipped',
        reason: `sandbox provider ${JSON.stringify(provider.name)} does not support bind-mount installs`,
      };
    }

    input.signal?.throwIfAborted();
    const startedAt = Date.now();
    let handle: BindMountSandboxHandle;
    try {
      handle = await provider.create({
        worktreePath: input.worktreePath,
        hostRepoPath: input.worktreePath,
        mounts: [
          { hostPath: input.worktreePath, sandboxPath: WORKSPACE_SANDBOX_PATH },
          ...(await resolveWorktreeGitMounts(input.worktreePath)),
        ],
        env: this.#sandboxEnv,
      });
    } catch (error) {
      return { status: 'failed', command: detected.command, error: describeInstallError(error) };
    }

    try {
      const result = await execWithDeadline(handle, detected.command, {
        timeoutMs: this.#installTimeoutMs,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      if (result === 'timeout') {
        return {
          status: 'failed',
          command: detected.command,
          error: `install exceeded ${this.#installTimeoutMs}ms`,
        };
      }
      if (result.exitCode !== 0) {
        return {
          status: 'failed',
          command: detected.command,
          error: tailForError(result.stderr !== '' ? result.stderr : result.stdout),
        };
      }
      if (seed !== null) {
        await refreshSeedCache(seed);
      }
      return {
        status: 'installed',
        packageManager: detected.packageManager,
        command: detected.command,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await handle.close();
    }
  }

  async runAgent(input: RunAgentInput): Promise<AgentRunResult> {
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
        env: this.#sandboxEnv,
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

    const usage = aggregateAgentRunUsage(result.iterations);
    return {
      stdout: result.stdout,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}

export function aggregateAgentRunUsage(
  iterations: readonly Pick<IterationResult, 'usage'>[],
): AgentRunUsage | undefined {
  let aggregate: AgentRunUsage | undefined;
  for (const { usage } of iterations) {
    if (usage === undefined) {
      continue;
    }
    if (aggregate === undefined) {
      aggregate = {
        inputTokens: usage.inputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        outputTokens: usage.outputTokens,
      };
      continue;
    }
    aggregate = {
      inputTokens: aggregate.inputTokens + usage.inputTokens,
      cacheCreationInputTokens: aggregate.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      cacheReadInputTokens: aggregate.cacheReadInputTokens + usage.cacheReadInputTokens,
      outputTokens: aggregate.outputTokens + usage.outputTokens,
    };
  }
  return aggregate;
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

/**
 * Run a command in the sandbox, bounded by a deadline and an abort signal.
 * The handle's exec has no cancellation of its own; the caller's `finally`
 * close() tears the VM down, which terminates a still-running command. An
 * abort rethrows the signal's reason so supersede/cancel semantics flow
 * through unchanged; a deadline resolves to 'timeout' so the caller can
 * report it as a failed install instead of failing the Review.
 */
async function execWithDeadline(
  handle: BindMountSandboxHandle,
  command: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult | 'timeout'> {
  const execPromise = handle.exec(command);
  // The exec settles after close() on the timeout/abort paths; without a
  // handler its rejection would surface as an unhandled rejection.
  execPromise.catch(() => {});

  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<ExecResult | 'timeout'>((resolve, reject) => {
      timeout = setTimeout(() => resolve('timeout'), options.timeoutMs);
      if (options.signal !== undefined) {
        const signal = options.signal;
        onAbort = () => reject(signal.reason ?? new Error('Dependency install was aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      execPromise.then(resolve, reject);
    });
  } finally {
    clearTimeout(timeout);
    if (options.signal !== undefined && onAbort !== undefined) {
      options.signal.removeEventListener('abort', onAbort);
    }
  }
}

const execFileAsync = promisify(execFile);

interface SeedCache {
  /** Worktree's node_modules destination. */
  worktreeNodeModules: string;
  /** Per-Repo cache directory holding the seed. */
  cacheDir: string;
  /** Cached node_modules tree inside cacheDir. */
  seedNodeModules: string;
  /** File recording the lockfile hash the seed was built from. */
  hashFile: string;
  /** Hash of the worktree's current lockfile. */
  lockfileHash: string;
}

async function seedCacheFor(
  worktreePath: string,
  cacheKey: string | undefined,
  lockfile: string | undefined,
  cacheRoot: string,
): Promise<SeedCache | null> {
  if (cacheKey === undefined || lockfile === undefined) {
    return null;
  }
  const segments = cacheKey.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  let lockfileHash: string;
  try {
    lockfileHash = createHash('sha256')
      .update(await readFile(join(worktreePath, lockfile)))
      .digest('hex');
  } catch {
    return null;
  }
  const cacheDir = join(cacheRoot, ...segments);
  return {
    worktreeNodeModules: join(worktreePath, 'node_modules'),
    cacheDir,
    seedNodeModules: join(cacheDir, 'node_modules'),
    hashFile: join(cacheDir, 'lockfile.sha256'),
    lockfileHash,
  };
}

/**
 * Clone the cached node_modules into the fresh worktree, host-side, before
 * the install VM starts. `cp -c` clones via APFS copy-on-write, so even a
 * multi-gigabyte seed lands in seconds; the in-VM install then verifies the
 * tree instead of materializing it file-by-file over virtiofs. Best-effort:
 * any failure removes the partial copy so it cannot poison the install.
 */
async function seedWorktreeFromCache(seed: SeedCache): Promise<void> {
  if (!(await pathExists(seed.seedNodeModules)) || (await pathExists(seed.worktreeNodeModules))) {
    return;
  }
  try {
    await execFileAsync('cp', ['-c', '-R', seed.seedNodeModules, seed.worktreeNodeModules], {
      timeout: SEED_COPY_TIMEOUT_MS,
    });
  } catch {
    await rm(seed.worktreeNodeModules, { recursive: true, force: true });
  }
}

/**
 * After a successful install, clone the worktree's node_modules back into
 * the per-Repo cache — but only when the lockfile changed since the seed was
 * built, so unchanged Reviews skip the copy entirely. Staged into a unique
 * sibling directory and swapped in by rename, so concurrent Reviews of the
 * same Repo can race without corrupting the seed. Best-effort: a failed
 * refresh leaves the previous seed in place.
 */
async function refreshSeedCache(seed: SeedCache): Promise<void> {
  try {
    const recordedHash = await readFile(seed.hashFile, 'utf8').then(
      (content) => content.trim(),
      () => '',
    );
    if (recordedHash === seed.lockfileHash && (await pathExists(seed.seedNodeModules))) {
      return;
    }
    if (!(await pathExists(seed.worktreeNodeModules))) {
      return;
    }
    await mkdir(seed.cacheDir, { recursive: true });
    const unique = `${process.pid}-${Date.now()}`;
    const staging = `${seed.seedNodeModules}.staging-${unique}`;
    const discard = `${seed.seedNodeModules}.discard-${unique}`;
    try {
      await execFileAsync('cp', ['-c', '-R', seed.worktreeNodeModules, staging], {
        timeout: SEED_COPY_TIMEOUT_MS,
      });
      if (await pathExists(seed.seedNodeModules)) {
        await rename(seed.seedNodeModules, discard);
      }
      await rename(staging, seed.seedNodeModules);
      await writeFile(seed.hashFile, `${seed.lockfileHash}\n`);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(discard, { recursive: true, force: true });
    }
  } catch {
    // Seeding is an accelerator, never a correctness requirement.
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make git work inside the install VM the same way sandcastle does for the
 * Agent VMs: a review worktree's `.git` is a file whose `gitdir:` points at
 * the host clone's `.git/worktrees/<name>`, so mount the clone's `.git`
 * directory at its identical host path. Repo `prepare` scripts need this —
 * graindevue's `lefthook install` dies with "not a git repository" without
 * it. Returns no mounts when the worktree has no git metadata at all.
 */
async function resolveWorktreeGitMounts(
  worktreePath: string,
): Promise<{ hostPath: string; sandboxPath: string }[]> {
  const gitPath = join(worktreePath, '.git');
  try {
    const gitStat = await stat(gitPath);
    if (gitStat.isDirectory()) {
      return [];
    }
    const match = (await readFile(gitPath, 'utf8')).trim().match(/^gitdir:\s*(.+)$/);
    if (match?.[1] === undefined) {
      return [];
    }
    const parentGitDir = resolve(match[1], '..', '..');
    return [{ hostPath: parentGitDir, sandboxPath: parentGitDir }];
  } catch {
    return [];
  }
}

const INSTALL_ERROR_TAIL_CHARS = 2000;

function tailForError(output: string): string {
  const trimmed = output.trim();
  if (trimmed === '') {
    return 'install command produced no output';
  }
  return trimmed.length <= INSTALL_ERROR_TAIL_CHARS
    ? trimmed
    : `… ${trimmed.slice(-INSTALL_ERROR_TAIL_CHARS)}`;
}

function describeInstallError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createDefaultAppleContainer(
  options?: AppleContainerRunnerOptions,
): Promise<SandboxProvider> {
  const { appleContainer } = (await import(
    APPLE_CONTAINER_PROVIDER_PACKAGE
  )) as AppleContainerProviderModule;
  return appleContainer(options);
}

const AGENT_PRIOR_CONTRACT = `

Agent priors and active Rules:
- Treat Agent-specific examples in the system prompt as non-exhaustive seed knowledge, not as a complete checklist.
- Product Rules and Repo-local Rules in this prompt are active, version-controlled instructions for this Review. If an active Rule conflicts with a seed example, follow the Rule.
- If a Rule and a seed example point at the same issue, emit at most one Finding and cite the strongest concrete evidence.`;
const SOURCE_VERIFICATION_CONTRACT = `

Framework source verification:
- Do not fetch dependency source preemptively. First inspect the diff, local code, ApiSurfaceManifest, and available local types/config.
- Before emitting a Finding whose correctness depends on framework or library behavior, verify that behavior against the installed version's source with opensrc. Local types/config can guide the search, but training memory or type-shape guesses do not prove runtime behavior.
- Useful pattern: run \`opensrc path <package>\`, then search the returned source path for the touched API or symbol with \`rg\`.
- Record the verification in the Finding.evidence: package name, installed version from the ApiSurfaceManifest when available, source path or symbol inspected, and the behavior confirmed.
- Memory or generic training knowledge is not evidence for a framework-behavior claim. If installed source contradicts the suspicion, or you cannot verify enough for the Finding's confidence, suppress the Finding.`;
const TOKEN_DISCIPLINE_CONTRACT = `

Token discipline:
- Prefer locating symbols with search (\`rg\`) before opening files, then read only the relevant matches.
- Prefer reading focused line ranges over whole files when a range is enough to verify behavior.
- Prefer running the narrowest relevant test first, then broaden only as needed.
- Avoid pasting full command logs into your output. Summarize noisy logs, but preserve exact file paths, line numbers, and error text needed to support Findings.`;

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
  const toolchainContext = formatDependencyInstallContext(input.dependencyInstall);
  return `${input.agent.systemPrompt}

Review PR #${pr.number}: ${pr.title}

Repository: ${pr.owner}/${pr.repo}
PR URL: ${pr.url}
Base ref: ${pr.baseRef}
Head SHA: ${pr.headSha}
${siblingContext}
${manifestContext}
${toolchainContext}
${formatReviewBotContext(input.botConfig)}
${AGENT_PRIOR_CONTRACT}
${formatSourceVerificationContract(input.agent)}
${TOKEN_DISCIPLINE_CONTRACT}

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

/**
 * Tell every Agent, explicitly, whether the sandbox can run package scripts.
 * When the install succeeded the Agents may execute tests for verified
 * Findings; when it was skipped or failed they must not burn their execution
 * budget discovering that pnpm/vitest cannot work (the pre-install failure
 * mode behind the logic Agent's timeouts on PR graindevue#236).
 */
function formatDependencyInstallContext(result: DependencyInstallResult | undefined): string {
  if (result === undefined) {
    return '';
  }
  switch (result.status) {
    case 'installed':
      return `
Sandbox toolchain:
- Dependencies are installed: \`${result.command}\` completed in ${Math.round(result.durationMs / 1000)}s before this Review. node_modules is present in the worktree.
- You MAY run the Repo's package scripts and tests directly (e.g. \`${result.packageManager} test\` or the test runner on specific files). Run the narrowest relevant test first.
- Do NOT re-run a dependency install; it already happened.
- In a monorepo, a test that fails to resolve a workspace package's entry needs that package built first — build only what the test imports (e.g. \`pnpm --filter <package> build\`), never the whole Repo.
`;
    case 'skipped':
      return `
Sandbox toolchain:
- No dependency install ran for this Review: ${result.reason}.
- node_modules is NOT available. Do NOT run package-manager or test commands (pnpm/npm/yarn/bun install, test runners, tsc) — they will fail and waste your execution budget.
- Limit yourself to static analysis. If a Finding would need test execution to confirm, state the hypothesis with the evidence you have and mark it unverified.
`;
    case 'failed':
      return `
Sandbox toolchain:
- Dependency install FAILED before this Review${result.command !== undefined ? ` (\`${result.command}\`)` : ''}: ${result.error}
- node_modules is NOT available. Do NOT run package-manager or test commands (pnpm/npm/yarn/bun install, test runners, tsc) — they will fail and waste your execution budget.
- Limit yourself to static analysis. If a Finding would need test execution to confirm, state the hypothesis with the evidence you have and mark it unverified.
`;
  }
}

function formatSourceVerificationContract(agent: AgentDefinition): string {
  if (!agent.tools.includes('opensrc')) {
    return '';
  }

  return SOURCE_VERIFICATION_CONTRACT;
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
