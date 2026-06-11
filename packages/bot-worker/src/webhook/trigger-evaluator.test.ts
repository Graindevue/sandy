import { describe, expect, it } from 'vitest';
import type {
  CheckRunEvent,
  CommentEvent,
  PullRequestEvent,
  PullRequestFacts,
  PushEvent,
  RepoRef,
} from './events.js';
import { evaluateTrigger, isForkPr, isReviewMention } from './trigger-evaluator.js';

const BASE_REPO: RepoRef = { owner: 'tony-co', name: 'sandy' };

function prFacts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    number: 42,
    draft: false,
    headSha: 'abc123',
    baseRef: 'main',
    title: 'Add feature',
    author: 'octocat',
    url: 'https://github.com/tony-co/sandy/pull/42',
    state: 'open',
    headRepo: { ...BASE_REPO },
    ...overrides,
  };
}

function commentEvent(body: string, prOverrides: Partial<PullRequestFacts> = {}): CommentEvent {
  return {
    kind: 'comment',
    repo: BASE_REPO,
    commentKind: 'issue_comment',
    body,
    pr: prFacts(prOverrides),
  };
}

function prEvent(
  action: PullRequestEvent['action'],
  prOverrides: Partial<PullRequestFacts> = {},
): PullRequestEvent {
  return { kind: 'pull_request', action, repo: BASE_REPO, pr: prFacts(prOverrides) };
}

function pushEvent(prOverrides: Partial<PullRequestFacts> = {}): PushEvent {
  return { kind: 'push', repo: BASE_REPO, pr: prFacts(prOverrides) };
}

function checkRunEvent(prOverrides: Partial<PullRequestFacts> = {}): CheckRunEvent {
  return { kind: 'check_run', repo: BASE_REPO, pr: prFacts(prOverrides) };
}

describe('isReviewMention', () => {
  it('matches @bot review with surrounding text', () => {
    expect(isReviewMention('hey @bot review please')).toBe(true);
    expect(isReviewMention('@bot review')).toBe(true);
    expect(isReviewMention('Please\n@bot   review\nthanks')).toBe(true);
    expect(isReviewMention('@BOT REVIEW')).toBe(true);
  });

  it('does not match unrelated text or near-misses', () => {
    expect(isReviewMention('looks good to me')).toBe(false);
    expect(isReviewMention('@bottle reviewer')).toBe(false);
    expect(isReviewMention('previewed by @bot')).toBe(false);
    expect(isReviewMention('email me @ bot review')).toBe(false);
  });
});

describe('isForkPr', () => {
  it('is false when head and base repos match (case-insensitively)', () => {
    expect(isForkPr(BASE_REPO, prFacts())).toBe(false);
    expect(isForkPr(BASE_REPO, prFacts({ headRepo: { owner: 'Tony-Co', name: 'Sandy' } }))).toBe(
      false,
    );
  });

  it('is true when the head repo differs from the base repo', () => {
    expect(
      isForkPr(BASE_REPO, prFacts({ headRepo: { owner: 'someone-else', name: 'sandy' } })),
    ).toBe(true);
    expect(isForkPr(BASE_REPO, prFacts({ headRepo: { owner: 'tony-co', name: 'fork' } }))).toBe(
      true,
    );
  });
});

describe('evaluateTrigger — manual-only triggering', () => {
  // The only two enqueue paths: an `@bot review` mention and the Re-run button.

  it('enqueues and opts in on an @bot review mention', () => {
    expect(evaluateTrigger(commentEvent('@bot review'))).toEqual({
      enqueue: true,
      setReviewActive: true,
      trigger: 'mention',
    });
  });

  it('ignores a comment without the mention', () => {
    expect(evaluateTrigger(commentEvent('nice work!'))).toEqual({ enqueue: false });
  });

  it('enqueues a Check Run re-run', () => {
    expect(evaluateTrigger(checkRunEvent())).toEqual({
      enqueue: true,
      setReviewActive: true,
      trigger: 'rerun',
    });
  });

  // No automatic triggers: pushes and every PR lifecycle action except close are
  // no-ops. A push to a PR never re-reviews it — the author re-runs the review.
  it('does nothing on a push, even to a previously-reviewed PR', () => {
    expect(evaluateTrigger(pushEvent())).toEqual({ enqueue: false });
  });

  it('does nothing on synchronize (push delivered as a PR event)', () => {
    expect(evaluateTrigger(prEvent('synchronize'))).toEqual({ enqueue: false });
  });

  it('does nothing on ready_for_review (draft → ready no longer auto-reviews)', () => {
    expect(evaluateTrigger(prEvent('ready_for_review'))).toEqual({ enqueue: false });
  });

  it('does nothing on opened or reopened', () => {
    expect(evaluateTrigger(prEvent('opened'))).toEqual({ enqueue: false });
    expect(evaluateTrigger(prEvent('reopened'))).toEqual({ enqueue: false });
  });

  // PR closed → clear the opt-in flag.
  it('clears reviewActive on close', () => {
    expect(evaluateTrigger(prEvent('closed'))).toEqual({
      enqueue: false,
      clearReviewActive: true,
    });
  });

  // Fork PRs (head repo ≠ base repo) are declined on the enqueue paths.
  it('declines a fork PR on a mention instead of opting it in', () => {
    const event = commentEvent('@bot review', { headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event)).toEqual({ enqueue: false, decline: 'fork' });
  });

  it('declines a fork PR on a Check Run re-run', () => {
    const event = checkRunEvent({ headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event)).toEqual({ enqueue: false, decline: 'fork' });
  });

  it('still clears a fork PR on close (close wins over decline)', () => {
    const event = prEvent('closed', { headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event)).toEqual({ enqueue: false, clearReviewActive: true });
  });

  // A mention on a closed or merged PR must not enqueue a job for a dead head SHA
  // nor re-arm reviewActive (which clear-on-close already cleared).
  it('does nothing on an @bot review mention on a closed PR', () => {
    expect(evaluateTrigger(commentEvent('@bot review', { state: 'closed' }))).toEqual({
      enqueue: false,
    });
  });

  it('does nothing on an @bot review mention on a merged PR', () => {
    expect(evaluateTrigger(commentEvent('@bot review', { state: 'merged' }))).toEqual({
      enqueue: false,
    });
  });

  // A null head repo (GitHub couldn't resolve it, e.g. deleted fork) is treated
  // as a fork and declined, not enqueued against an unfetchable SHA.
  it('declines a PR whose head repo is unknown (null) on a mention', () => {
    const event = commentEvent('@bot review', { headRepo: null });
    expect(evaluateTrigger(event)).toEqual({ enqueue: false, decline: 'fork' });
  });

  it('does nothing on a Check Run re-run for a closed PR', () => {
    expect(evaluateTrigger(checkRunEvent({ state: 'closed' }))).toEqual({ enqueue: false });
  });

  it('does nothing for an ignored event', () => {
    expect(evaluateTrigger({ kind: 'ignored', reason: 'test' })).toEqual({ enqueue: false });
  });
});

describe('isForkPr — null head repo', () => {
  it('is true when the head repo is unknown (null)', () => {
    expect(isForkPr(BASE_REPO, prFacts({ headRepo: null }))).toBe(true);
  });
});
