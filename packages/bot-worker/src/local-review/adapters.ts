import type {
  AgentRunStatus,
  AgentRunUsage,
  Confidence,
  ReviewJobStatus,
  SiblingShas,
} from '@sandy/shared-types';
import { isIgnoredPath } from '../config/ignore.js';
import type {
  PostedReviewResult,
  PostedSummaryComment,
  PostReviewResultInput,
  PostScopeDeclinedInput,
} from '../worker/poster.js';
import type {
  RecordAgentRunInput,
  RecordSynthesizedReviewInput,
  ReviewDiffInspector,
  ReviewExecutionStore,
  ReviewJobContext,
  ReviewPoster,
} from '../worker/review-executor.js';
import type { PersistedFinding, PostableFinding } from '../worker/review-findings.js';
import { runGit } from './git.js';

export interface NumstatEntry {
  added: number;
  deleted: number;
  path: string;
}

/** Parse `git diff --numstat -z`; binary files count as zero lines, as on GitHub. */
export function parseNumstat(output: string): NumstatEntry[] {
  const records = output.split('\0');
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < records.length; ) {
    const record = records[index++];
    if (record === undefined || record === '') continue;
    // Paths are unquoted under `-z` and may themselves contain tabs.
    const [, added, deleted, inlinePath] = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(record) ?? [];
    if (added === undefined || deleted === undefined || inlinePath === undefined) {
      throw new Error('Git emitted an invalid numstat record');
    }
    // A rename leaves the path empty and follows with the old and new paths.
    let path = inlinePath;
    if (inlinePath === '') {
      index++;
      path = records[index++] ?? '';
    }
    if (path === '') throw new Error('Git emitted a numstat record without a path');
    entries.push({ added: lineCount(added), deleted: lineCount(deleted), path });
  }
  return entries;
}

function lineCount(raw: string): number {
  return raw === '-' ? 0 : Number(raw);
}

/** Measures the committed diff the way GitHub sizes a pull request. */
export class LocalDiffInspector implements ReviewDiffInspector {
  readonly #root: string;
  readonly #revision: string;
  readonly #signal: AbortSignal | undefined;
  /** The last measured size, after the Repo's `.bot/ignore.gitignore` patterns. */
  changedLines: number | undefined;

  constructor(options: { root: string; baseSha: string; headSha: string; signal?: AbortSignal }) {
    this.#root = options.root;
    this.#revision = `${options.baseSha}...${options.headSha}`;
    this.#signal = options.signal;
  }

  async changedLineCount(_target: unknown, ignorePatterns: readonly string[] = []) {
    const { stdout } = await this.#git([
      'diff',
      '--numstat',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      this.#revision,
      '--',
    ]);
    this.changedLines = parseNumstat(stdout)
      .filter((entry) => !isIgnoredPath(entry.path, ignorePatterns))
      .reduce((total, entry) => total + entry.added + entry.deleted, 0);
    return this.changedLines;
  }

  async changedPaths(): Promise<string[]> {
    const { stdout } = await this.#git([
      'diff',
      '--name-only',
      '-z',
      '--no-ext-diff',
      '--find-renames',
      this.#revision,
      '--',
    ]);
    return stdout.split('\0').filter((path) => path !== '');
  }

  async #git(args: readonly string[]) {
    return await runGit(
      this.#root,
      args,
      this.#signal === undefined ? {} : { signal: this.#signal },
    );
  }
}

export interface LocalAgentRun {
  key: string;
  status: Exclude<AgentRunStatus, 'running'>;
  findingCount: number;
  durationMs: number;
  error?: string;
  usage?: AgentRunUsage;
}

/** Keeps one Review in memory; nothing is sent to Convex. */
export class LocalReviewStore implements ReviewExecutionStore {
  readonly #context: ReviewJobContext;
  status: ReviewJobStatus = 'running';
  /** `null` until synthesis, and for an incomplete Review. */
  confidenceScore: Confidence | null = null;
  findings: PersistedFinding[] = [];
  readonly agentRuns: LocalAgentRun[] = [];
  siblingShas: SiblingShas = {};
  error: string | undefined;

  constructor(context: ReviewJobContext) {
    this.#context = context;
  }

  async getReviewJobContext(jobId: string): Promise<ReviewJobContext | null> {
    return jobId === this.#context.job.id ? this.#context : null;
  }

  async getReviewJobStatus(jobId: string): Promise<ReviewJobStatus | null> {
    return jobId === this.#context.job.id ? this.status : null;
  }

  async recordApiSurfaceManifest(): Promise<void> {}

  async recordSiblingShas(_jobId: string, siblingShas: SiblingShas): Promise<void> {
    this.siblingShas = { ...siblingShas };
  }

  async recordSynthesizedReview(input: RecordSynthesizedReviewInput): Promise<PersistedFinding[]> {
    this.confidenceScore = input.confidenceScore;
    this.findings = input.findings.map((finding, index) => ({
      id: `finding-${index + 1}`,
      finding,
    }));
    return this.findings;
  }

  async markFindingPosted(): Promise<void> {}

  async recordAgentRun(input: RecordAgentRunInput): Promise<void> {
    this.agentRuns.push({
      key: input.agentKey,
      status: input.status,
      findingCount: input.findingCount,
      durationMs: Math.max(0, input.finishedAt - input.startedAt),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    });
  }

  async setReviewCheckRunId(): Promise<void> {}

  async markCompleted(_jobId: string): Promise<boolean> {
    if (this.status !== 'running') return false;
    this.status = 'completed';
    return true;
  }

  async markFailed(_jobId: string, _finishedAt: number, error: string): Promise<boolean> {
    if (this.status !== 'running') return false;
    this.status = 'failed';
    this.error = error;
    return true;
  }
}

/** Captures what CI would post on the pull request. */
export class LocalReviewPoster implements ReviewPoster {
  result: { findings: PostableFinding[]; summary: string } | undefined;
  declined: { changedLines: number; maxChangedLines: number } | undefined;

  async postReviewResult(input: PostReviewResultInput): Promise<PostedReviewResult> {
    this.result = { findings: [...input.findings], summary: input.summary };
    return { postedFindings: [], summaryComment: { commentId: 0, url: '' } };
  }

  async postScopeDeclined(input: PostScopeDeclinedInput): Promise<PostedSummaryComment> {
    this.declined = { changedLines: input.changedLines, maxChangedLines: input.maxChangedLines };
    return { commentId: 0, url: '' };
  }
}
