import { describe, expect, it } from 'vitest';
import type {
  CommentEvent,
  PullRequestEvent,
  PullRequestFacts,
  PushEvent,
  RepoRef,
} from './events.js';
import {
  evaluateTrigger,
  isForkPr,
  isReviewMention,
  type ReadyForReviewSkipReason,
  type TriggerEvaluationContext,
} from './trigger-evaluator.js';

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

function triggerContext(
  currentReviewActive: boolean,
  readyForReviewSkipReason?: ReadyForReviewSkipReason,
): TriggerEvaluationContext {
  return { currentReviewActive, readyForReviewSkipReason };
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

describe('evaluateTrigger — Sticky Opt-In matrix', () => {
  // Rule 1: opened / synchronize on an opted-out PR with no mention → do nothing.
  it('does nothing when a PR is opened with reviewActive=false', () => {
    expect(evaluateTrigger(prEvent('opened'), triggerContext(false))).toEqual({ enqueue: false });
  });

  it('does nothing on synchronize when reviewActive=false', () => {
    expect(evaluateTrigger(prEvent('synchronize'), triggerContext(false))).toEqual({
      enqueue: false,
    });
  });

  it('does nothing on reopened', () => {
    expect(evaluateTrigger(prEvent('reopened'), triggerContext(false))).toEqual({
      enqueue: false,
    });
    expect(evaluateTrigger(prEvent('reopened'), triggerContext(true))).toEqual({
      enqueue: false,
    });
  });

  // Rule 2: @bot review mention → enqueue + set reviewActive=true (trigger mention).
  it('enqueues and opts in on an @bot review mention', () => {
    expect(evaluateTrigger(commentEvent('@bot review'), triggerContext(false))).toEqual({
      enqueue: true,
      setReviewActive: true,
      trigger: 'mention',
    });
  });

  it('ignores a comment without the mention', () => {
    expect(evaluateTrigger(commentEvent('nice work!'), triggerContext(false))).toEqual({
      enqueue: false,
    });
  });

  it('still enqueues on mention even if already opted in', () => {
    expect(evaluateTrigger(commentEvent('@bot review'), triggerContext(true))).toEqual({
      enqueue: true,
      setReviewActive: true,
      trigger: 'mention',
    });
  });

  // Rule 3: draft → ready transition → enqueue + set reviewActive=true (trigger ready).
  it('enqueues and opts in on ready_for_review', () => {
    expect(evaluateTrigger(prEvent('ready_for_review'), triggerContext(false))).toEqual({
      enqueue: true,
      setReviewActive: true,
      trigger: 'ready',
    });
  });

  it('skips ready_for_review when the base branch is excluded', () => {
    expect(
      evaluateTrigger(prEvent('ready_for_review'), triggerContext(false, 'base-branch-excluded')),
    ).toEqual({
      enqueue: false,
      skip: 'base-branch-excluded',
    });
  });

  it('still enqueues an @bot review mention when the base branch is excluded', () => {
    expect(
      evaluateTrigger(
        commentEvent('@bot review', { baseRef: 'release/2026.06' }),
        triggerContext(false, 'base-branch-excluded'),
      ),
    ).toEqual({
      enqueue: true,
      setReviewActive: true,
      trigger: 'mention',
    });
  });

  // Rule 4: push to a reviewActive PR → enqueue (trigger push).
  it('enqueues a push when the PR is opted in', () => {
    expect(evaluateTrigger(pushEvent(), triggerContext(true))).toEqual({
      enqueue: true,
      trigger: 'push',
    });
  });

  it('still enqueues a push to an opted-in PR when the base branch is excluded', () => {
    expect(
      evaluateTrigger(
        pushEvent({ baseRef: 'release/2026.06' }),
        triggerContext(true, 'base-branch-excluded'),
      ),
    ).toEqual({
      enqueue: true,
      trigger: 'push',
    });
  });

  it('ignores a push when the PR is opted out', () => {
    expect(evaluateTrigger(pushEvent(), triggerContext(false))).toEqual({ enqueue: false });
  });

  it('treats synchronize on an opted-in PR as a push re-review', () => {
    expect(evaluateTrigger(prEvent('synchronize'), triggerContext(true))).toEqual({
      enqueue: true,
      trigger: 'push',
    });
  });

  // Rule 5: PR closed → clear reviewActive.
  it('clears reviewActive on close', () => {
    expect(evaluateTrigger(prEvent('closed'), triggerContext(true))).toEqual({
      enqueue: false,
      clearReviewActive: true,
    });
  });

  it('clears reviewActive on close even when already opted out', () => {
    expect(evaluateTrigger(prEvent('closed'), triggerContext(false))).toEqual({
      enqueue: false,
      clearReviewActive: true,
    });
  });

  // Rule 6: fork PR (head repo ≠ base repo) → decline, never enqueue.
  it('declines a fork PR on a mention instead of opting it in', () => {
    const event = commentEvent('@bot review', { headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event, triggerContext(false))).toEqual({
      enqueue: false,
      decline: 'fork',
    });
  });

  it('declines a fork PR on ready_for_review', () => {
    const event = prEvent('ready_for_review', { headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event, triggerContext(false))).toEqual({
      enqueue: false,
      decline: 'fork',
    });
  });

  it('declines a fork PR on ready_for_review even when the base branch is excluded', () => {
    const event = prEvent('ready_for_review', { headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event, triggerContext(false, 'base-branch-excluded'))).toEqual({
      enqueue: false,
      decline: 'fork',
    });
  });

  it('declines a fork PR on a push to an opted-in PR', () => {
    const event = pushEvent({ headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event, triggerContext(true))).toEqual({
      enqueue: false,
      decline: 'fork',
    });
  });

  it('declines a fork PR on synchronize to an opted-in PR', () => {
    const event = prEvent('synchronize', { headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event, triggerContext(true))).toEqual({
      enqueue: false,
      decline: 'fork',
    });
  });

  it('still clears a fork PR on close (close wins over decline)', () => {
    const event = prEvent('closed', { headRepo: { owner: 'forker', name: 'sandy' } });
    expect(evaluateTrigger(event, triggerContext(true))).toEqual({
      enqueue: false,
      clearReviewActive: true,
    });
  });

  // Finding #3: a mention on a closed or merged PR must not enqueue a job for a
  // dead head SHA nor re-arm reviewActive (which clear-on-close already cleared).
  it('does nothing on an @bot review mention on a closed PR', () => {
    const event = commentEvent('@bot review', { state: 'closed' });
    expect(evaluateTrigger(event, triggerContext(false))).toEqual({ enqueue: false });
    // Even if the flag was somehow still set, the mention must not re-enqueue.
    expect(evaluateTrigger(event, triggerContext(true))).toEqual({ enqueue: false });
  });

  it('does nothing on an @bot review mention on a merged PR', () => {
    const event = commentEvent('@bot review', { state: 'merged' });
    expect(evaluateTrigger(event, triggerContext(false))).toEqual({ enqueue: false });
    expect(evaluateTrigger(event, triggerContext(true))).toEqual({ enqueue: false });
  });

  // Finding #4: a null head repo (GitHub couldn't resolve it, e.g. deleted fork)
  // is treated as a fork and declined, not enqueued against an unfetchable SHA.
  it('declines a PR whose head repo is unknown (null) on a mention', () => {
    const event = commentEvent('@bot review', { headRepo: null });
    expect(evaluateTrigger(event, triggerContext(false))).toEqual({
      enqueue: false,
      decline: 'fork',
    });
  });

  it('declines a null-head-repo PR on a push to an opted-in PR', () => {
    const event = pushEvent({ headRepo: null });
    expect(evaluateTrigger(event, triggerContext(true))).toEqual({
      enqueue: false,
      decline: 'fork',
    });
  });

  // Follow-up: a push / synchronize on a closed or merged PR must not enqueue
  // even when `reviewActive` is stale (a missed `closed` webhook) — the parsed
  // PR state is authoritative, the flag alone is not.
  it('does nothing on a push to a closed PR even when reviewActive is stale', () => {
    expect(evaluateTrigger(pushEvent({ state: 'closed' }), triggerContext(true))).toEqual({
      enqueue: false,
    });
  });

  it('does nothing on a push to a closed excluded-branch PR even when reviewActive is stale', () => {
    expect(
      evaluateTrigger(
        pushEvent({ baseRef: 'release/2026.06', state: 'closed' }),
        triggerContext(true, 'base-branch-excluded'),
      ),
    ).toEqual({
      enqueue: false,
    });
  });

  it('does nothing on a synchronize to a merged PR even when reviewActive is stale', () => {
    expect(
      evaluateTrigger(prEvent('synchronize', { state: 'merged' }), triggerContext(true)),
    ).toEqual({
      enqueue: false,
    });
  });

  it('does nothing for an ignored event', () => {
    expect(evaluateTrigger({ kind: 'ignored', reason: 'test' }, triggerContext(true))).toEqual({
      enqueue: false,
    });
  });
});

describe('isForkPr — null head repo (finding #4)', () => {
  it('is true when the head repo is unknown (null)', () => {
    expect(isForkPr(BASE_REPO, prFacts({ headRepo: null }))).toBe(true);
  });
});
