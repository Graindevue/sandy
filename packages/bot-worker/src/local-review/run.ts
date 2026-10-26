import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentDefinition, Finding } from '@sandy/shared-types';
import { BotConfigReader } from '../config/bot-config-reader.js';
import type { ResolvedRepo } from '../config/loader.js';
import {
  resolveConfiguredAgent,
  resolveConfiguredAgents,
  resolveReviewBotConfig,
} from '../config/review-config.js';
import { disabledArchetypeAssigner } from '../learning/archetype-assigner.js';
import { CodexAppServerRunner } from '../worker/codex-app-server-runner.js';
import { ReviewExecutor, type ReviewJobContext } from '../worker/review-executor.js';
import { REVIEW_INSTRUCTIONS_LIMIT } from '../worker/review-prompt.js';
import { LocalDiffInspector, LocalReviewPoster, LocalReviewStore } from './adapters.js';
import { loadLocalReviewConfig } from './config.js';
import { LocalReviewInputError } from './errors.js';
import {
  checkoutWorktrees,
  gitCommonDir,
  hasCommittedChanges,
  type LocalCheckout,
  parseRemoteRepository,
  type RemoteRepository,
  type ReviewBase,
  readLocalCheckout,
  resolveReviewBase,
  uncommittedEntryCount,
} from './git.js';
import {
  type LocalReviewFinding,
  type LocalReviewResult,
  type LocalReviewStatus,
  newReviewId,
  saveReview,
} from './history.js';
import {
  acquireReviewLock,
  assertDedicatedHome,
  canonicalPath,
  ensureHomeDirectories,
  hasCodexLogin,
  hiddenPathsFrom,
  isWithin,
  type LocalReviewHome,
  localProtectedPaths,
  localReviewHome,
} from './home.js';
import { clearInterruptedReviews, LocalCloneManager } from './workspace.js';

/** Matches the GitHub Action's default `max-changed-lines` input. */
export const DEFAULT_LOCAL_MAX_CHANGED_LINES = 5000;

export interface LocalReviewOptions {
  /** Root of the Sandy package: its `agents/` and optional `.config/bot.yaml`. */
  sandyRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `--branch`: what the branch would merge into. */
  base?: string;
  /** `--repo owner/name`, for a checkout whose origin does not name the Repo. */
  repo?: string;
  configPath?: string;
  codexHome?: string;
  /** Replaces every Agent's configured model. */
  model?: string;
  fastMode?: boolean;
  instructions?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => Date;
}

/**
 * Review the committed diff of the current branch with the same executor,
 * Agents, and synthesis CI uses. Nothing is posted to GitHub or recorded in
 * Convex; the result is returned and saved under the CLI home.
 */
export async function runLocalReview(options: LocalReviewOptions): Promise<LocalReviewResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const warn = options.warn ?? log;
  const startedAt = now();
  const instructions = options.instructions?.trim() || undefined;
  if (instructions !== undefined && instructions.length > REVIEW_INSTRUCTIONS_LIMIT) {
    throw new LocalReviewInputError(
      `--instructions is limited to ${REVIEW_INSTRUCTIONS_LIMIT} characters`,
    );
  }
  const model = options.model?.trim() || undefined;
  const maxChangedLines = positiveInteger(
    options.env.SANDY_REVIEW_MAX_CHANGED_LINES,
    'SANDY_REVIEW_MAX_CHANGED_LINES',
    DEFAULT_LOCAL_MAX_CHANGED_LINES,
  );
  const hiddenPaths = hiddenPathsFrom(options.env);

  const home = localReviewHome(options.env, options.codexHome);
  await assertDedicatedHome(home);
  const checkout = await readLocalCheckout(options.cwd);
  const requested = reviewedRepository(options.repo, checkout.originUrl);
  const base = await resolveReviewBase(checkout.root, checkout.headSha, options.base);
  const id = newReviewId(startedAt);
  const warnings: string[] = [];
  const report = (fields: ReportFields): LocalReviewResult => ({
    id,
    status: fields.status,
    repository: fields.repository ?? `${requested.owner}/${requested.name}`,
    branch: checkout.branch,
    base: { ref: base.label, sha: base.sha, mergeBase: base.mergeBase },
    head: checkout.headSha,
    changedLines: fields.changedLines,
    confidenceScore: fields.confidenceScore ?? null,
    summary: fields.summary,
    findings: fields.findings ?? [],
    agents: fields.agents ?? [],
    warnings,
    ...(fields.error === undefined ? {} : { error: fields.error }),
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
  });

  if (!(await hasCommittedChanges(checkout.root, base.sha, checkout.headSha))) {
    return report({
      status: 'no_changes',
      changedLines: 0,
      summary: `No committed changes between ${base.label} and HEAD; commit your work to review it.`,
    });
  }
  const checkoutRoots = await checkoutRootsOf(checkout.root);
  await assertSeparateFromCheckouts(home, checkoutRoots);
  if (!(await hasCodexLogin(home))) {
    throw new LocalReviewInputError(
      'sandy review needs its own Codex login; run `sandy login` first',
    );
  }
  await ensureHomeDirectories(home);
  const uncommitted = await uncommittedEntryCount(checkout.root);
  if (uncommitted > 0) {
    const message = `${uncommitted} uncommitted ${uncommitted === 1 ? 'change is' : 'changes are'} not part of this review; only commits are reviewed`;
    warnings.push(message);
    warn(message);
  }
  const config = await loadLocalReviewConfig({
    sandyRoot: options.sandyRoot,
    home,
    repo: requested,
    checkoutRoot: checkout.root,
    base,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  const resolved = config.loader.resolveForRepo(requested.owner, requested.name);
  if (resolved === null) throw new Error(`${requested.owner}/${requested.name} has no Product`);
  log(`Product configuration: ${config.source}`);

  const release = await acquireReviewLock(home.lock);
  try {
    await clearInterruptedReviews(home);
    const protectedPaths = [
      ...(await localProtectedPaths({
        home,
        checkoutRoots,
        sandyRoot: options.sandyRoot,
        ...(config.configPath === undefined ? {} : { configPath: config.configPath }),
        hiddenPaths,
      })),
      ...(await unrelatedClones(home, resolved)),
    ];
    const context = reviewContext({ id, resolved, checkout, base });
    const signalOption = options.signal === undefined ? {} : { signal: options.signal };
    const store = new LocalReviewStore(context);
    const poster = new LocalReviewPoster();
    const diffInspector = new LocalDiffInspector({
      root: checkout.root,
      baseSha: base.sha,
      headSha: checkout.headSha,
      ...signalOption,
    });
    const cloneManager = new LocalCloneManager({
      home,
      reviewId: id,
      checkoutRoot: checkout.root,
      originUrl: checkout.originUrl,
      reviewed: resolved.repo,
      headSha: checkout.headSha,
      base,
      log,
      ...signalOption,
    });
    const reader = new BotConfigReader({
      repoPath: async (repo) => {
        if (sameRepo(repo, resolved.repo)) return checkout.root;
        await cloneManager.ensureCloned(repo);
        return cloneManager.siblingPath(repo);
      },
    });
    const withModel = (agent: AgentDefinition): AgentDefinition =>
      model === undefined ? agent : { ...agent, model };
    const executable = options.env.SANDY_CODEX_EXECUTABLE?.trim() || undefined;
    const executor = new ReviewExecutor({
      store,
      cloneManager,
      diffInspector,
      runner: new CodexAppServerRunner({
        codexHome: home.codexHome,
        enableManagedRuntime: false,
        testMode: 'targeted',
        protectedPaths,
        env: { OPENSRC_HOME: join(home.root, 'opensrc') },
        logger: { info: log },
        ...(executable === undefined ? {} : { executable }),
      }),
      poster,
      archetypeAssigner: disabledArchetypeAssigner,
      manifestBuilder: {
        buildManifest: async (productId, repos) => {
          const { buildManifest } = await import('@sandy/manifest-builder');
          return await buildManifest(productId, repos);
        },
      },
      resolveAgent: (repo, key) => {
        const agent = resolveConfiguredAgent(config.loader, repo, key);
        return agent === null ? null : withModel(agent);
      },
      resolveAgents: (repo) => resolveConfiguredAgents(config.loader, repo).map(withModel),
      // Unlike CI, the size check reads `.bot/` at the branch head: the default
      // branch may exist only as a stale local ref.
      resolveReviewBotConfig: ({ context: job, repo, worktreePath, repoSources }) =>
        resolveReviewBotConfig(
          config.loader,
          reader,
          repo,
          worktreePath ?? checkout.root,
          job.job.headSha,
          repoSources,
        ),
      maxChangedLines,
      maxAgentConcurrency: 1,
      fastMode: options.fastMode ?? false,
      ...(instructions === undefined ? {} : { instructions }),
      ...signalOption,
      logger: {
        info: log,
        warn: (message, ...details) => warn([message, ...details.map(describeError)].join(' ')),
      },
    });

    await executor.executeClaimedJob(id);
    if (options.signal?.aborted) throw options.signal.reason;

    const repository = `${resolved.repo.owner}/${resolved.repo.name}`;
    const changedLines = diffInspector.changedLines ?? null;
    const agents = [...store.agentRuns];
    if (poster.declined !== undefined) {
      const { changedLines: measured, maxChangedLines: limit } = poster.declined;
      const review = report({
        status: 'declined',
        repository,
        changedLines: measured,
        summary: `Review declined: ${measured.toLocaleString('en-US')} changed lines exceed the ${limit.toLocaleString('en-US')}-line limit. Split the branch or raise SANDY_REVIEW_MAX_CHANGED_LINES.`,
      });
      await saveReview(home, review);
      return review;
    }
    const findings = (poster.result?.findings ?? store.findings)
      .map(({ id: findingId, finding }) => localFinding(findingId, finding))
      .sort(compareFindings);
    const status: LocalReviewStatus =
      store.status !== 'completed'
        ? 'failed'
        : agents.some((agent) => agent.status !== 'completed')
          ? 'incomplete'
          : 'completed';
    const review = report({
      status,
      repository,
      changedLines,
      confidenceScore: status === 'completed' ? store.confidenceScore : null,
      summary: poster.result?.summary ?? unpostedSummary(status, agents.length),
      findings,
      agents,
      ...(store.error === undefined ? {} : { error: store.error }),
    });
    await saveReview(home, review);
    return review;
  } finally {
    await release();
  }
}

interface ReportFields {
  status: LocalReviewStatus;
  repository?: string;
  changedLines: number | null;
  confidenceScore?: LocalReviewResult['confidenceScore'];
  summary: string;
  findings?: LocalReviewFinding[];
  agents?: LocalReviewResult['agents'];
  error?: string;
}

/** CI posts nothing when no Agent was selected, and nothing after an early failure. */
function unpostedSummary(status: LocalReviewStatus, agentCount: number): string {
  if (status === 'failed') return 'The Review failed before it produced a result.';
  return agentCount === 0 ? 'No reviewer applied to this diff, so nothing was reviewed.' : '';
}

function reviewedRepository(
  requested: string | undefined,
  originUrl: string | null,
): RemoteRepository {
  if (requested !== undefined) {
    const [, owner, name] = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(requested.trim()) ?? [];
    if (owner === undefined || name === undefined || [owner, name].some(isDotSegment)) {
      throw new LocalReviewInputError('--repo must be owner/name');
    }
    return { owner, name };
  }
  const parsed = originUrl === null ? null : parseRemoteRepository(originUrl);
  if (parsed === null) {
    throw new LocalReviewInputError(
      'Cannot tell which Repo this checkout is; add an origin remote or pass --repo owner/name',
    );
  }
  return parsed;
}

function isDotSegment(segment: string): boolean {
  return segment === '.' || segment === '..';
}

/** The checkout, its shared Git directory, and every linked worktree of the same repository. */
async function checkoutRootsOf(root: string): Promise<string[]> {
  const roots = [root, await gitCommonDir(root), ...(await checkoutWorktrees(root))];
  return [...new Set(await Promise.all(roots.map((path) => canonicalPath(path))))];
}

/**
 * Agents may not read the developer's checkouts, so the Review's own state,
 * the runner's caches, and per-Agent temporary homes must live elsewhere.
 */
async function assertSeparateFromCheckouts(
  home: LocalReviewHome,
  checkoutRoots: readonly string[],
): Promise<void> {
  const state: readonly (readonly [string, string])[] = [
    ['The sandy CLI home', await canonicalPath(home.root)],
    ['The Codex home parent', dirname(await canonicalPath(home.codexHome))],
    ['The temporary directory', await canonicalPath(tmpdir())],
  ];
  for (const root of checkoutRoots) {
    for (const [label, path] of state) {
      if (isWithin(path, root)) {
        throw new LocalReviewInputError(`${label} ${path} is inside the checkout ${root}`);
      }
      if (label !== 'The temporary directory' && isWithin(root, path)) {
        throw new LocalReviewInputError(`The checkout ${root} is inside ${label.toLowerCase()}`);
      }
    }
  }
}

/** Sibling clones kept for other Products stay hidden from this Review's Agents. */
async function unrelatedClones(home: LocalReviewHome, resolved: ResolvedRepo): Promise<string[]> {
  const product = new Set(resolved.product.repos.map((repo) => repo.fullName.toLowerCase()));
  const paths: string[] = [];
  for (const owner of await readdir(home.repos).catch(() => [])) {
    if (owner === '.worktrees') continue;
    for (const name of await readdir(join(home.repos, owner)).catch(() => [])) {
      if (!product.has(`${owner}/${name}`.toLowerCase())) paths.push(join(home.repos, owner, name));
    }
  }
  return paths;
}

function reviewContext(input: {
  id: string;
  resolved: ResolvedRepo;
  checkout: LocalCheckout;
  base: ReviewBase;
}): ReviewJobContext {
  const { id, resolved, checkout, base } = input;
  const branch = checkout.branch ?? `HEAD (detached at ${checkout.headSha.slice(0, 12)})`;
  return {
    job: {
      id,
      pullRequestId: `local-${id}`,
      repoId: `local:${resolved.repo.fullName}`,
      headSha: checkout.headSha,
      agentKeys: [],
      confidenceScore: 0,
      agentRuns: [],
    },
    repo: {
      id: `local:${resolved.repo.fullName}`,
      owner: resolved.repo.owner,
      name: resolved.repo.name,
      defaultBranch: resolved.repo.defaultBranch,
    },
    product: {
      id: `local:${resolved.product.slug}`,
      slug: resolved.product.slug,
      name: resolved.product.name,
      repos: resolved.product.repos.map((repo) => ({
        id: `local:${repo.fullName}`,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
      })),
    },
    pullRequest: {
      id: `local-${id}`,
      number: 0,
      headSha: checkout.headSha,
      baseRef: base.label.startsWith('origin/') ? base.label.slice('origin/'.length) : base.label,
      title: branch,
      url: '',
      baseSha: base.sha,
      localBranch: branch,
    },
  };
}

function localFinding(id: string, finding: Finding): LocalReviewFinding {
  return {
    id,
    severity: finding.severity,
    confidence: finding.confidence,
    category: finding.category,
    agentKey: finding.agentKey,
    repo: finding.anchor.repo,
    path: finding.anchor.path,
    lineStart: finding.anchor.lineStart,
    lineEnd: finding.anchor.lineEnd,
    summary: finding.summary,
    evidence: finding.evidence,
    ...(finding.suggestedFix === undefined ? {} : { suggestedFix: finding.suggestedFix }),
    ...(finding.alsoReportedBy === undefined || finding.alsoReportedBy.length === 0
      ? {}
      : { alsoReportedBy: [...finding.alsoReportedBy] }),
    ...(finding.crossRepoReferences === undefined || finding.crossRepoReferences.length === 0
      ? {}
      : {
          crossRepoReferences: finding.crossRepoReferences.map((reference) => ({ ...reference })),
        }),
  };
}

/** Most severe first, then most confident, then by location. */
function compareFindings(left: LocalReviewFinding, right: LocalReviewFinding): number {
  return (
    left.severity.localeCompare(right.severity) ||
    right.confidence - left.confidence ||
    left.repo.localeCompare(right.repo) ||
    left.path.localeCompare(right.path) ||
    left.lineStart - right.lineStart
  );
}

function sameRepo(left: RemoteRepository, right: RemoteRepository): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function positiveInteger(raw: string | undefined, name: string, fallback: number): number {
  const value = raw?.trim();
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new LocalReviewInputError(`${name} must be a positive integer`);
  }
  return parsed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
