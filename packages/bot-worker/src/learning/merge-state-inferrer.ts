import type { FindingAnchor, ReactionKind } from '@sandy/shared-types';
import type { RepoRef } from '../github/types.js';
import { findingIdsFromCommentTrailer } from './comment-trailer.js';
import type { ReactionCaptureComment, ReactionCaptureGitHub } from './reaction-capture.js';

export type MergeStateReactionKind = Extract<ReactionKind, 'mergedFixed' | 'mergedIgnored'>;

export interface MergeStateTarget {
  findingId: string;
  githubCommentId?: number;
  anchor: FindingAnchor;
}

export interface MergeStateCommit {
  sha: string;
  committedAt: number;
}

export interface MergeStateCommitFile {
  filename: string;
  previousFilename?: string;
  patch?: string;
}

export interface MergeStateGitHub
  extends Pick<ReactionCaptureGitHub, 'listReactionCaptureComments'> {
  listPullRequestCommits(input: { repo: RepoRef; pullNumber: number }): Promise<MergeStateCommit[]>;
  listCommitFiles(input: { repo: RepoRef; commitSha: string }): Promise<MergeStateCommitFile[]>;
}

export interface MergeStateStore {
  listMergeStateTargetsForPr(pullRequestId: string): Promise<MergeStateTarget[]>;
  recordMergeStateReaction(input: {
    findingId: string;
    kind: MergeStateReactionKind;
  }): Promise<boolean>;
  listMergedPullRequestsForMergeStateBackfill(
    limit: number,
  ): Promise<Array<{ pullRequestId: string; repo: RepoRef; pullNumber: number }>>;
  markMergeStateSignalsRolledUp(input: {
    pullRequestId: string;
    rolledUpAt: number;
  }): Promise<void>;
}

export interface InferPrMergeStateSignalsInput {
  repo: RepoRef;
  pullNumber: number;
  pullRequestId: string;
  store: Pick<MergeStateStore, 'listMergeStateTargetsForPr' | 'recordMergeStateReaction'>;
  github: MergeStateGitHub;
}

export interface InferPrMergeStateSignalsResult {
  recorded: number;
}

export interface RollupMergeStateSignalsInput {
  store: MergeStateStore;
  github: MergeStateGitHub;
  limit?: number;
  now?: () => number;
}

export interface RollupMergeStateSignalsResult {
  checked: number;
  recorded: number;
}

export interface MergeStateSignalCron {
  runNow(): Promise<RollupMergeStateSignalsResult>;
  stop(): void;
}

export interface MergeStateSignalCronLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

const DEFAULT_BACKFILL_LIMIT = 25;
const DEFAULT_CRON_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export async function inferPrMergeStateSignals(
  input: InferPrMergeStateSignalsInput,
): Promise<InferPrMergeStateSignalsResult> {
  const targets = await input.store.listMergeStateTargetsForPr(input.pullRequestId);
  if (targets.length === 0) {
    return { recorded: 0 };
  }

  const comments = await input.github.listReactionCaptureComments({
    repo: input.repo,
    pullNumber: input.pullNumber,
  });
  const candidates = mergeStateCandidates(input.repo, targets, comments);
  if (candidates.length === 0) {
    return { recorded: 0 };
  }

  const commits = await input.github.listPullRequestCommits({
    repo: input.repo,
    pullNumber: input.pullNumber,
  });
  const filesByCommit = new Map<string, Promise<MergeStateCommitFile[]>>();

  let recorded = 0;
  for (const candidate of candidates) {
    const touched = await candidateWasTouchedAfterComment({
      candidate,
      commits,
      repo: input.repo,
      github: input.github,
      filesByCommit,
    });
    const kind: MergeStateReactionKind = touched ? 'mergedFixed' : 'mergedIgnored';
    const inserted = await input.store.recordMergeStateReaction({
      findingId: candidate.target.findingId,
      kind,
    });
    if (inserted) {
      recorded += 1;
    }
  }

  return { recorded };
}

export async function rollupMergeStateSignals(
  input: RollupMergeStateSignalsInput,
): Promise<RollupMergeStateSignalsResult> {
  const pullRequests = await input.store.listMergedPullRequestsForMergeStateBackfill(
    input.limit ?? DEFAULT_BACKFILL_LIMIT,
  );
  const rolledUpAt = (input.now ?? Date.now)();

  let recorded = 0;
  for (const pullRequest of pullRequests) {
    const result = await inferPrMergeStateSignals({
      repo: pullRequest.repo,
      pullNumber: pullRequest.pullNumber,
      pullRequestId: pullRequest.pullRequestId,
      store: input.store,
      github: input.github,
    });
    recorded += result.recorded;
    await input.store.markMergeStateSignalsRolledUp({
      pullRequestId: pullRequest.pullRequestId,
      rolledUpAt,
    });
  }

  return { checked: pullRequests.length, recorded };
}

export function startMergeStateSignalCron(
  input: RollupMergeStateSignalsInput & {
    intervalMs?: number;
    logger?: MergeStateSignalCronLogger;
  },
): MergeStateSignalCron {
  const logger = input.logger ?? console;
  const runNow = async () => {
    const result = await rollupMergeStateSignals(input);
    logger.info(
      `rolled up merge-state signals for ${result.checked} merged PR(s), recorded ${result.recorded}`,
    );
    return result;
  };
  const timer = setInterval(() => {
    runNow().catch((error: unknown) => {
      logger.warn('failed to roll up merge-state signals', error);
    });
  }, input.intervalMs ?? DEFAULT_CRON_INTERVAL_MS);
  timer.unref?.();
  return {
    runNow,
    stop() {
      clearInterval(timer);
    },
  };
}

interface MergeStateCandidate {
  target: MergeStateTarget;
  commentCreatedAt: number;
}

function mergeStateCandidates(
  repo: RepoRef,
  targets: readonly MergeStateTarget[],
  comments: readonly ReactionCaptureComment[],
): MergeStateCandidate[] {
  const reviewedRepo = `${repo.owner}/${repo.name}`.toLowerCase();
  const targetsByFindingId = new Map(
    targets
      .filter((target) => target.anchor.repo.toLowerCase() === reviewedRepo)
      .map((target) => [target.findingId, target]),
  );
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  const candidatesByFindingId = new Map<string, MergeStateCandidate>();

  for (const target of targetsByFindingId.values()) {
    if (target.githubCommentId === undefined) {
      continue;
    }
    const comment = commentsById.get(target.githubCommentId);
    if (comment?.createdAt === undefined) {
      continue;
    }
    candidatesByFindingId.set(target.findingId, {
      target,
      commentCreatedAt: comment.createdAt,
    });
  }

  for (const comment of comments) {
    if (comment.createdAt === undefined) {
      continue;
    }
    for (const findingId of findingIdsFromCommentTrailer(comment.body)) {
      const target = targetsByFindingId.get(findingId);
      if (target === undefined) {
        continue;
      }
      candidatesByFindingId.set(findingId, { target, commentCreatedAt: comment.createdAt });
    }
  }

  return [...candidatesByFindingId.values()];
}

async function candidateWasTouchedAfterComment(input: {
  candidate: MergeStateCandidate;
  commits: readonly MergeStateCommit[];
  repo: RepoRef;
  github: Pick<MergeStateGitHub, 'listCommitFiles'>;
  filesByCommit: Map<string, Promise<MergeStateCommitFile[]>>;
}): Promise<boolean> {
  for (const commit of input.commits) {
    if (commit.committedAt <= input.candidate.commentCreatedAt) {
      continue;
    }
    const files = await filesForCommit(input.repo, commit.sha, input.github, input.filesByCommit);
    if (files.some((file) => fileTouchesAnchor(file, input.candidate.target.anchor))) {
      return true;
    }
  }
  return false;
}

function filesForCommit(
  repo: RepoRef,
  commitSha: string,
  github: Pick<MergeStateGitHub, 'listCommitFiles'>,
  filesByCommit: Map<string, Promise<MergeStateCommitFile[]>>,
): Promise<MergeStateCommitFile[]> {
  const existing = filesByCommit.get(commitSha);
  if (existing !== undefined) {
    return existing;
  }
  const pending = github.listCommitFiles({ repo, commitSha });
  filesByCommit.set(commitSha, pending);
  return pending;
}

function fileTouchesAnchor(file: MergeStateCommitFile, anchor: FindingAnchor): boolean {
  if (file.filename !== anchor.path && file.previousFilename !== anchor.path) {
    return false;
  }
  if (file.patch === undefined) {
    return true;
  }
  return patchTouchesRange(file.patch, anchor.lineStart, anchor.lineEnd);
}

export function patchTouchesRange(patch: string, lineStart: number, lineEnd: number): boolean {
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const line of patch.split('\n')) {
    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (oldLine === undefined || newLine === undefined || line.length === 0) {
      continue;
    }

    const marker = line[0];
    switch (marker) {
      case ' ':
        oldLine += 1;
        newLine += 1;
        break;
      case '-':
        if (lineOverlapsRange(oldLine, lineStart, lineEnd)) {
          return true;
        }
        oldLine += 1;
        break;
      case '+':
        if (lineOverlapsRange(newLine, lineStart, lineEnd)) {
          return true;
        }
        newLine += 1;
        break;
      default:
        break;
    }
  }

  return false;
}

function lineOverlapsRange(line: number, lineStart: number, lineEnd: number): boolean {
  return line >= lineStart && line <= lineEnd;
}
