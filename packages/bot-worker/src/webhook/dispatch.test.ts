import { describe, expect, it, vi } from 'vitest';
import { dispatchEvent, FORK_DECLINE_MESSAGE } from './dispatch.js';
import type {
  CommentEvent,
  PullRequestEvent,
  PullRequestFacts,
  PushEvent,
  RepoRef,
} from './events.js';
import type { EnqueueInput, ReviewSink, UpsertPullRequestInput } from './sink.js';

const BASE_REPO: RepoRef = { owner: 'tony-co', name: 'sandy' };

function prFacts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    number: 7,
    draft: false,
    headSha: 'sha-7',
    baseRef: 'main',
    title: 'PR',
    author: 'octocat',
    url: 'https://example.test/pr/7',
    state: 'open',
    headRepo: { ...BASE_REPO },
    ...overrides,
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn() };

/**
 * In-memory {@link ReviewSink} that records calls and models the parts of Convex
 * the dispatcher relies on: `ensureRepo` is idempotent per `owner/name`, the PR's
 * `reviewActive` flag is stored and read back, and ids are deterministic strings.
 */
class FakeSink implements ReviewSink {
  reviewActive: boolean;
  readonly upserts: UpsertPullRequestInput[] = [];
  readonly enqueued: EnqueueInput[] = [];
  setActiveCalls: Array<{ id: string; active: boolean }> = [];
  clearCalls: string[] = [];
  jobCounter = 0;

  constructor(reviewActive = false) {
    this.reviewActive = reviewActive;
  }

  async ensureRepo(repo: RepoRef): Promise<string> {
    return `repo:${repo.owner}/${repo.name}`;
  }

  async getReviewActive(): Promise<boolean> {
    return this.reviewActive;
  }

  async upsertPullRequest(input: UpsertPullRequestInput): Promise<string> {
    this.upserts.push(input);
    return `pr:${input.repoId}#${input.number}`;
  }

  async setReviewActive(id: string, active: boolean): Promise<void> {
    this.setActiveCalls.push({ id, active });
    this.reviewActive = active;
  }

  async clearOnClose(id: string): Promise<void> {
    this.clearCalls.push(id);
    this.reviewActive = false;
  }

  async enqueueReviewJob(input: EnqueueInput): Promise<string> {
    this.enqueued.push(input);
    this.jobCounter += 1;
    return `job:${this.jobCounter}`;
  }
}

function comment(body: string, prOverrides: Partial<PullRequestFacts> = {}): CommentEvent {
  return { kind: 'comment', repo: BASE_REPO, body, pr: prFacts(prOverrides) };
}

function pr(
  action: PullRequestEvent['action'],
  prOverrides: Partial<PullRequestFacts> = {},
): PullRequestEvent {
  // A real `closed` delivery carries `state: 'closed'`; default the fixture to
  // match so `prStateForEvent` persists the true lifecycle state.
  const state: PullRequestFacts['state'] = action === 'closed' ? 'closed' : 'open';
  return { kind: 'pull_request', action, repo: BASE_REPO, pr: prFacts({ state, ...prOverrides }) };
}

function push(prOverrides: Partial<PullRequestFacts> = {}): PushEvent {
  return { kind: 'push', repo: BASE_REPO, pr: prFacts(prOverrides) };
}

describe('dispatchEvent', () => {
  it('ignores an ignored event without any side effects', async () => {
    const sink = new FakeSink();
    const outcome = await dispatchEvent({ kind: 'ignored', reason: 'ping' }, sink, silentLogger);
    expect(outcome).toEqual({ action: 'ignored', reason: 'ping' });
    expect(sink.upserts).toHaveLength(0);
    expect(sink.enqueued).toHaveLength(0);
  });

  // AC: PR opened with reviewActive=false → no ReviewJob.
  it('opened on an opted-out PR upserts but enqueues nothing', async () => {
    const sink = new FakeSink(false);
    const outcome = await dispatchEvent(pr('opened'), sink, silentLogger);
    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(sink.upserts).toHaveLength(1);
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
  });

  // AC: @bot review enqueues a ReviewJob and flips reviewActive=true.
  it('@bot review enqueues a logic job and flips reviewActive', async () => {
    const sink = new FakeSink(false);
    const outcome = await dispatchEvent(comment('@bot review'), sink, silentLogger);
    expect(outcome).toMatchObject({ action: 'enqueued', trigger: 'mention' });
    expect(sink.setActiveCalls).toEqual([{ id: 'pr:repo:tony-co/sandy#7', active: true }]);
    expect(sink.enqueued).toEqual([
      {
        pullRequestId: 'pr:repo:tony-co/sandy#7',
        repoId: 'repo:tony-co/sandy',
        headSha: 'sha-7',
        trigger: 'mention',
        agentKeys: ['logic'],
      },
    ]);
  });

  // AC: subsequent push to a reviewActive PR enqueues without a new mention.
  it('synchronize on an opted-in PR enqueues a push job without re-flipping', async () => {
    const sink = new FakeSink(true);
    const outcome = await dispatchEvent(pr('synchronize'), sink, silentLogger);
    expect(outcome).toMatchObject({ action: 'enqueued', trigger: 'push' });
    expect(sink.setActiveCalls).toHaveLength(0);
    expect(sink.enqueued[0]).toMatchObject({ trigger: 'push', agentKeys: ['logic'] });
  });

  it('synchronize on an opted-out PR does nothing', async () => {
    const sink = new FakeSink(false);
    const outcome = await dispatchEvent(pr('synchronize'), sink, silentLogger);
    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(sink.enqueued).toHaveLength(0);
  });

  // AC: PR close clears reviewActive.
  it('close clears reviewActive and enqueues nothing', async () => {
    const sink = new FakeSink(true);
    const outcome = await dispatchEvent(pr('closed'), sink, silentLogger);
    expect(outcome).toMatchObject({ action: 'cleared' });
    expect(sink.clearCalls).toEqual(['pr:repo:tony-co/sandy#7']);
    expect(sink.enqueued).toHaveLength(0);
    // The PR row is upserted with closed state before the flag is cleared.
    expect(sink.upserts[0]?.state).toBe('closed');
  });

  // AC: a fork PR is declined with a documented-limitation message, not reviewed.
  it('declines a fork PR on mention without upserting or enqueuing', async () => {
    const warn = vi.fn();
    const sink = new FakeSink(false);
    const outcome = await dispatchEvent(
      comment('@bot review', { headRepo: { owner: 'forker', name: 'sandy' } }),
      sink,
      { info: vi.fn(), warn },
    );
    expect(outcome).toEqual({ action: 'declined-fork', repo: 'tony-co/sandy', number: 7 });
    expect(sink.upserts).toHaveLength(0);
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(FORK_DECLINE_MESSAGE));
  });

  it('enqueues a push job for a direct push event on an opted-in PR', async () => {
    const sink = new FakeSink(true);
    const outcome = await dispatchEvent(push(), sink, silentLogger);
    expect(outcome).toMatchObject({ action: 'enqueued', trigger: 'push' });
    expect(sink.enqueued[0]).toMatchObject({ headSha: 'sha-7', trigger: 'push' });
  });

  // Finding #3: a mention on a closed PR must not enqueue, must not flip
  // reviewActive, and must not clobber the stored state back to 'open'.
  it('does not enqueue or re-arm on an @bot review mention on a closed PR', async () => {
    const sink = new FakeSink(false);
    const outcome = await dispatchEvent(
      comment('@bot review', { state: 'closed' }),
      sink,
      silentLogger,
    );
    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
    // The PR row is upserted with its real (closed) state, not clobbered to open.
    expect(sink.upserts[0]?.state).toBe('closed');
  });

  it('does not enqueue or re-arm on an @bot review mention on a merged PR', async () => {
    const sink = new FakeSink(false);
    const outcome = await dispatchEvent(
      comment('@bot review', { state: 'merged' }),
      sink,
      silentLogger,
    );
    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
    expect(sink.upserts[0]?.state).toBe('merged');
  });

  // Finding #4: a PR whose head repo GitHub could not resolve (null) is declined
  // like a fork — never enqueued against an unfetchable head SHA.
  it('declines a PR with an unknown (null) head repo without upserting or enqueuing', async () => {
    const warn = vi.fn();
    const sink = new FakeSink(false);
    const outcome = await dispatchEvent(comment('@bot review', { headRepo: null }), sink, {
      info: vi.fn(),
      warn,
    });
    expect(outcome).toEqual({ action: 'declined-fork', repo: 'tony-co/sandy', number: 7 });
    expect(sink.upserts).toHaveLength(0);
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(FORK_DECLINE_MESSAGE));
  });
});
