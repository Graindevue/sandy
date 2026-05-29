import { describe, expect, it } from 'vitest';
import type { CommentEvent, ParsedEvent, PullRequestEvent, PushEvent } from './events.js';
import { parseEvent, parseEventForDispatch, prStateForEvent } from './parse.js';

/**
 * Raw-payload fixtures shaped like the GitHub webhook deliveries Sandy reads (a
 * deliberately partial slice — GitHub sends far more). These mirror real
 * structures so {@link parseEvent} is exercised end-to-end without a live
 * delivery.
 */

const REPO = { owner: { login: 'tony-co' }, name: 'sandy' };

interface RawPrOptions {
  number?: number;
  state?: string;
  merged?: boolean;
  headRepo?: { owner: { login: string }; name: string } | null;
}

function rawPullRequest(opts: RawPrOptions = {}): Record<string, unknown> {
  const { number = 42, state = 'open', merged = false, headRepo } = opts;
  return {
    number,
    draft: false,
    title: 'Add feature',
    html_url: 'https://github.com/tony-co/sandy/pull/42',
    state,
    merged,
    user: { login: 'octocat' },
    head: {
      sha: 'abc123',
      // `headRepo: undefined` means "key omitted"; `null` is GitHub's deleted-fork
      // signal; otherwise an explicit repo (same-repo by default).
      repo: headRepo === undefined ? REPO : headRepo,
    },
    base: { ref: 'main' },
  };
}

/** A `pull_request_review_comment` delivery with the given `action`. */
function reviewCommentPayload(action: string, body: string, rawPr: RawPrOptions = {}) {
  return {
    action,
    repository: REPO,
    comment: { body },
    pull_request: rawPullRequest(rawPr),
  };
}

/** A `pull_request` delivery with the given `action`. */
function pullRequestPayload(action: string, rawPr: RawPrOptions = {}) {
  return { action, repository: REPO, pull_request: rawPullRequest(rawPr) };
}

function issueCommentPayload(action: string, body: string) {
  return {
    action,
    repository: REPO,
    issue: {
      number: 42,
      pull_request: { url: 'https://api.github.com/repos/tony-co/sandy/pulls/42' },
    },
    comment: { body },
  };
}

function pushPayload(ref = 'refs/heads/feature') {
  return {
    repository: REPO,
    ref,
    after: 'abc123',
  };
}

function expectComment(event: ParsedEvent): CommentEvent {
  expect(event.kind).toBe('comment');
  return event as CommentEvent;
}

function expectPullRequest(event: ParsedEvent): PullRequestEvent {
  expect(event.kind).toBe('pull_request');
  return event as PullRequestEvent;
}

function expectPush(event: ParsedEvent): PushEvent {
  expect(event.kind).toBe('push');
  return event as PushEvent;
}

describe('parseEvent — pull_request_review_comment action (finding #2)', () => {
  // A `created` review comment carrying the mention is the one actionable case.
  it('parses a created @bot review comment as a comment event', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('created', '@bot review'),
    );
    const comment = expectComment(event);
    expect(comment.body).toBe('@bot review');
  });

  // Deleting the opt-in comment must NOT start a review: the payload still
  // carries the body + full pull_request, so without an action guard it would
  // dispatch as a live mention.
  it('ignores a deleted review comment even when it contains @bot review', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('deleted', '@bot review'),
    );
    expect(event.kind).toBe('ignored');
  });

  // Editing the opt-in comment must NOT re-fire a duplicate review.
  it('ignores an edited review comment even when it contains @bot review', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('edited', '@bot review'),
    );
    expect(event.kind).toBe('ignored');
  });
});

describe('parseEventForDispatch — issue_comment hydration', () => {
  it('resolves PR facts for a created PR Conversation comment', async () => {
    const event = await parseEventForDispatch(
      'issue_comment',
      issueCommentPayload('created', '@bot review'),
      {
        async resolvePullRequest(repo, number) {
          expect(repo).toEqual({ owner: 'tony-co', name: 'sandy' });
          expect(number).toBe(42);
          return expectComment(
            parseEvent(
              'pull_request_review_comment',
              reviewCommentPayload('created', '@bot review'),
            ),
          ).pr;
        },
      },
    );

    const comment = expectComment(event);
    expect(comment.body).toBe('@bot review');
    expect(comment.pr.headSha).toBe('abc123');
  });

  it('ignores an edited PR Conversation comment without resolving PR details', async () => {
    let resolved = false;
    const event = await parseEventForDispatch(
      'issue_comment',
      issueCommentPayload('edited', '@bot review'),
      {
        async resolvePullRequest() {
          resolved = true;
          return null;
        },
      },
    );

    expect(event.kind).toBe('ignored');
    expect(resolved).toBe(false);
  });

  it('ignores a PR Conversation comment when PR resolution fails', async () => {
    const event = await parseEventForDispatch(
      'issue_comment',
      issueCommentPayload('created', '@bot review'),
      {
        async resolvePullRequest() {
          throw new Error('GitHub is unavailable');
        },
      },
    );

    expect(event).toEqual({
      kind: 'ignored',
      reason: 'issue_comment: pull_request resolution failed: GitHub is unavailable',
    });
  });
});

describe('parseEventForDispatch — push hydration', () => {
  it('resolves a branch push to the matching open PR facts', async () => {
    const resolved: Array<{
      repo: { owner: string; name: string };
      branch: string;
      headSha: string;
    }> = [];
    const event = await parseEventForDispatch('push', pushPayload(), {
      async resolvePullRequest() {
        return null;
      },
      async resolvePullRequestForPush(repo, branch, headSha) {
        resolved.push({ repo, branch, headSha });
        return expectPullRequest(parseEvent('pull_request', pullRequestPayload('synchronize'))).pr;
      },
    });

    const push = expectPush(event);
    expect(push.pr.headSha).toBe('abc123');
    expect(resolved).toEqual([
      { repo: { owner: 'tony-co', name: 'sandy' }, branch: 'feature', headSha: 'abc123' },
    ]);
  });

  it('ignores a push when no open PR maps to the branch head', async () => {
    const event = await parseEventForDispatch('push', pushPayload(), {
      async resolvePullRequest() {
        return null;
      },
      async resolvePullRequestForPush() {
        return null;
      },
    });

    expect(event).toEqual({ kind: 'ignored', reason: 'push: no open pull request for head' });
  });
});

describe('parseEvent — PR lifecycle state (finding #3)', () => {
  it('parses an open PR comment with state "open"', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('created', '@bot review', { state: 'open' }),
    );
    expect(expectComment(event).pr.state).toBe('open');
  });

  it('parses a closed (unmerged) PR comment with state "closed"', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('created', '@bot review', { state: 'closed', merged: false }),
    );
    expect(expectComment(event).pr.state).toBe('closed');
  });

  // `merged: true` always wins (GitHub reports merged PRs as state: 'closed').
  it('parses a merged PR as state "merged" even though GitHub sends state:"closed"', () => {
    const event = parseEvent(
      'pull_request',
      pullRequestPayload('closed', { state: 'closed', merged: true }),
    );
    expect(expectPullRequest(event).pr.state).toBe('merged');
  });

  // prStateForEvent must reflect the real state, not hard-code 'open' for
  // comments — otherwise a comment on a closed PR clobbers the stored state.
  it('prStateForEvent reflects the parsed state for a comment on a closed PR', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('created', '@bot review', { state: 'closed' }),
    );
    expect(prStateForEvent(expectComment(event)).state).toBe('closed');
  });

  it('prStateForEvent reports "merged" for a merged PR (no clobber to open)', () => {
    const event = parseEvent(
      'pull_request',
      pullRequestPayload('closed', { state: 'closed', merged: true }),
    );
    expect(prStateForEvent(expectPullRequest(event)).state).toBe('merged');
  });
});

describe('parseEvent — null head repo (finding #4)', () => {
  // GitHub sends head.repo: null when the source fork was deleted. The head must
  // NOT be attributed to the base repo; headRepo stays null so the fork-decline
  // guard can decline it.
  it('parses head.repo: null to headRepo null (not the base repo)', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('created', '@bot review', { headRepo: null }),
    );
    expect(expectComment(event).pr.headRepo).toBeNull();
  });

  it('keeps a genuine cross-repo fork head repo distinct from the base', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('created', '@bot review', {
        headRepo: { owner: { login: 'forker' }, name: 'sandy' },
      }),
    );
    expect(expectComment(event).pr.headRepo).toEqual({ owner: 'forker', name: 'sandy' });
  });

  it('keeps a same-repo PR head repo equal to the base', () => {
    const event = parseEvent(
      'pull_request_review_comment',
      reviewCommentPayload('created', '@bot review'),
    );
    expect(expectComment(event).pr.headRepo).toEqual({ owner: 'tony-co', name: 'sandy' });
  });
});
