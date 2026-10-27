import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Confidence,
  CrossRepoReference,
  FindingCategory,
  Severity,
} from '@sandy/shared-types';
import type { LocalAgentRun } from './adapters.js';
import { LocalReviewInputError } from './errors.js';
import type { LocalReviewHome } from './home.js';

/** Saved Reviews beyond this count are deleted, oldest first. */
export const SAVED_REVIEW_LIMIT = 50;

/**
 * `incomplete`: some reviewers failed, so the Review is unscored.
 * `declined`: the diff exceeds the changed-line limit; nothing ran.
 * `no_changes`: the branch has no committed diff; never saved.
 */
export type LocalReviewStatus = 'completed' | 'incomplete' | 'failed' | 'declined' | 'no_changes';

export interface LocalReviewFinding {
  id: string;
  severity: Severity;
  confidence: Confidence;
  category: FindingCategory;
  agentKey: string;
  /** `owner/name` the Finding is anchored in; the reviewed Repo unless a sibling is named. */
  repo: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  summary: string;
  evidence: string;
  suggestedFix?: string;
  alsoReportedBy?: string[];
  crossRepoReferences?: CrossRepoReference[];
}

/** The `--json` output, also saved for `sandy review show`. */
export interface LocalReviewResult {
  id: string;
  status: LocalReviewStatus;
  repository: string;
  /** Reviewed branch, or `null` for a detached HEAD. */
  branch: string | null;
  base: { ref: string; sha: string; mergeBase: string };
  head: string;
  changedLines: number | null;
  /** 0–5, where 5 is clean; `null` when the Review is incomplete or did not run. */
  confidenceScore: Confidence | null;
  summary: string;
  findings: LocalReviewFinding[];
  agents: LocalAgentRun[];
  warnings: string[];
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/** Sortable ids such as `20261025T101500123Z-a1b2c3`, to the millisecond. */
export function newReviewId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\.(\d{3})Z$/, '$1Z')
    .replace(/[-:]/g, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export async function saveReview(
  home: LocalReviewHome,
  review: LocalReviewResult,
): Promise<string> {
  await mkdir(home.reviews, { recursive: true, mode: 0o700 });
  await chmod(home.reviews, 0o700);
  const path = join(home.reviews, `${review.id}.json`);
  // `list` and `show` read without the review lock, so the file appears whole.
  const temporary = join(home.reviews, `.${review.id}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  for (const stale of (await savedReviewIds(home)).slice(SAVED_REVIEW_LIMIT)) {
    await rm(join(home.reviews, `${stale}.json`), { force: true });
  }
  return path;
}

/** Saved Reviews, newest first. Unreadable files are skipped. */
export async function listReviews(home: LocalReviewHome): Promise<LocalReviewResult[]> {
  const reviews: LocalReviewResult[] = [];
  for (const id of await savedReviewIds(home)) {
    const review = await readReview(home, id);
    if (review !== null) reviews.push(review);
  }
  return reviews;
}

/** The newest Review, or the one whose id is `id` or starts with it. */
export async function findReview(
  home: LocalReviewHome,
  id?: string,
): Promise<LocalReviewResult | null> {
  const ids = await savedReviewIds(home);
  if (id === undefined) {
    for (const candidate of ids) {
      const review = await readReview(home, candidate);
      if (review !== null) return review;
    }
    return null;
  }
  if (!/^[A-Za-z0-9-]+$/.test(id)) {
    throw new LocalReviewInputError('A Review id contains only letters, digits, and hyphens');
  }
  if (ids.includes(id)) return await readReview(home, id);
  const matches = ids.filter((candidate) => candidate.startsWith(id));
  if (matches.length > 1) {
    throw new LocalReviewInputError(`Review id ${id} matches ${matches.length} saved Reviews`);
  }
  const [match] = matches;
  return match === undefined ? null : await readReview(home, match);
}

async function savedReviewIds(home: LocalReviewHome): Promise<string[]> {
  const entries = await readdir(home.reviews).catch(() => []);
  return entries
    .filter((entry) => /^[A-Za-z0-9-]+\.json$/.test(entry))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort()
    .reverse();
}

async function readReview(home: LocalReviewHome, id: string): Promise<LocalReviewResult | null> {
  try {
    const review = JSON.parse(await readFile(join(home.reviews, `${id}.json`), 'utf8')) as unknown;
    return isReviewResult(review) ? review : null;
  } catch {
    return null;
  }
}

function isReviewResult(value: unknown): value is LocalReviewResult {
  if (typeof value !== 'object' || value === null) return false;
  const review = value as Partial<LocalReviewResult>;
  return (
    typeof review.id === 'string' &&
    typeof review.status === 'string' &&
    typeof review.repository === 'string' &&
    typeof review.head === 'string' &&
    typeof review.summary === 'string' &&
    Array.isArray(review.findings) &&
    Array.isArray(review.agents) &&
    Array.isArray(review.warnings)
  );
}
