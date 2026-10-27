import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findReview,
  type LocalReviewResult,
  listReviews,
  newReviewId,
  SAVED_REVIEW_LIMIT,
  saveReview,
} from './history.js';
import { type LocalReviewHome, localReviewHome } from './home.js';

const interruptedWrite = vi.hoisted(() => ({ enabled: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...[file, data, options]: Parameters<typeof actual.writeFile>) => {
      if (!interruptedWrite.enabled) return actual.writeFile(file, data, options);
      await actual.writeFile(file, String(data).slice(0, 10), options);
      throw new Error('write interrupted');
    },
  };
});

let home: LocalReviewHome;

beforeEach(async () => {
  home = localReviewHome({ SANDY_CLI_HOME: await mkdtemp(join(tmpdir(), 'sandy-history-')) });
});

afterEach(async () => {
  interruptedWrite.enabled = false;
  await rm(home.root, { recursive: true, force: true });
});

function review(id: string, overrides: Partial<LocalReviewResult> = {}): LocalReviewResult {
  return {
    id,
    status: 'completed',
    repository: 'acme/widgets',
    branch: 'feature/sum',
    base: { ref: 'origin/main', sha: 'b'.repeat(40), mergeBase: 'b'.repeat(40) },
    head: 'a'.repeat(40),
    changedLines: 4,
    confidenceScore: 5,
    summary: 'No issues found.',
    findings: [],
    agents: [],
    warnings: [],
    startedAt: '2026-10-25T10:00:00.000Z',
    finishedAt: '2026-10-25T10:05:00.000Z',
    ...overrides,
  };
}

describe('newReviewId', () => {
  it('starts with a sortable UTC timestamp and ends with a random suffix', () => {
    const id = newReviewId(new Date('2026-10-25T10:15:00.123Z'));

    expect(id).toMatch(/^20261025T101500Z-[0-9a-f]{6}$/);
    expect(newReviewId(new Date('2026-10-25T10:15:01Z')) > id).toBe(true);
  });
});

describe('saved Reviews', () => {
  it('has nothing to show before the first Review', async () => {
    expect(await listReviews(home)).toEqual([]);
    expect(await findReview(home)).toBeNull();
  });

  it('saves owner-only files and lists them newest first', async () => {
    const path = await saveReview(home, review('20261025T100000Z-aaaaaa'));
    await saveReview(home, review('20261025T110000Z-bbbbbb', { status: 'incomplete' }));

    expect(path).toBe(join(home.reviews, '20261025T100000Z-aaaaaa.json'));
    expect((await stat(home.reviews)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await listReviews(home)).toEqual([
      review('20261025T110000Z-bbbbbb', { status: 'incomplete' }),
      review('20261025T100000Z-aaaaaa'),
    ]);
  });

  it('finds the newest Review, an exact id, or a unique prefix', async () => {
    await saveReview(home, review('20261025T100000Z-aaaaaa'));
    await saveReview(home, review('20261025T110000Z-bbbbbb'));
    await saveReview(home, review('20261025T110500Z-cccccc'));

    expect((await findReview(home))?.id).toBe('20261025T110500Z-cccccc');
    expect((await findReview(home, '20261025T110000Z-bbbbbb'))?.id).toBe('20261025T110000Z-bbbbbb');
    expect((await findReview(home, '20261025T10'))?.id).toBe('20261025T100000Z-aaaaaa');
    expect(await findReview(home, '20261024')).toBeNull();
    await expect(findReview(home, '20261025T11')).rejects.toThrow(
      'Review id 20261025T11 matches 2 saved Reviews',
    );
    await expect(findReview(home, '../reviews')).rejects.toThrow(
      'A Review id contains only letters, digits, and hyphens',
    );
  });

  it('leaves nothing behind when a save stops partway', async () => {
    await saveReview(home, review('20261025T100000Z-aaaaaa'));
    interruptedWrite.enabled = true;

    await expect(saveReview(home, review('20261025T110000Z-bbbbbb'))).rejects.toThrow(
      'write interrupted',
    );
    expect(await readdir(home.reviews)).toEqual(['20261025T100000Z-aaaaaa.json']);
  });

  it('skips files that are not saved Reviews', async () => {
    await saveReview(home, review('20261025T100000Z-aaaaaa'));
    await writeFile(join(home.reviews, '20261025T120000Z-dddddd.json'), '{"id":');
    await writeFile(join(home.reviews, '20261025T130000Z-eeeeee.json'), '{"id":"x"}\n');
    await writeFile(join(home.reviews, 'notes.txt'), 'not a Review\n');

    expect((await listReviews(home)).map((saved) => saved.id)).toEqual(['20261025T100000Z-aaaaaa']);
    expect((await findReview(home))?.id).toBe('20261025T100000Z-aaaaaa');
    expect(await findReview(home, '20261025T13')).toBeNull();
  });

  it(`keeps only the newest ${SAVED_REVIEW_LIMIT} Reviews`, async () => {
    const ids = Array.from(
      { length: SAVED_REVIEW_LIMIT + 2 },
      (_, index) => `20261025T${String(index).padStart(6, '0')}Z-aaaaaa`,
    );
    for (const id of ids) await saveReview(home, review(id));

    const saved = (await readdir(home.reviews)).sort();
    expect(saved).toHaveLength(SAVED_REVIEW_LIMIT);
    expect(saved[0]).toBe(`${ids[2]}.json`);
    expect(saved.at(-1)).toBe(`${ids.at(-1)}.json`);
  });
});
