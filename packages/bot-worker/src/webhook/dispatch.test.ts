import { describe, expect, it, vi } from 'vitest';
import { dispatchEvent, FORK_DECLINE_MESSAGE } from './dispatch.js';
import type {
  CheckRunEvent,
  CommentEvent,
  PullRequestEvent,
  PullRequestFacts,
  PushEvent,
  RepoRef,
} from './events.js';
import type {
  EnqueueInput,
  EnqueueSupersedingResult,
  ReviewSink,
  UpsertPullRequestInput,
} from './sink.js';

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
 * the dispatcher relies on: `ensureRepo` is idempotent per `owner/name` and ids
 * are deterministic strings. The `reviewActive` opt-in flag is written but never
 * read back (manual-only triggering no longer gates on it), so the fake just
 * records the set/clear calls.
 */
class FakeSink implements ReviewSink {
  readonly upserts: UpsertPullRequestInput[] = [];
  readonly enqueued: EnqueueInput[] = [];
  readonly supersedingEnqueues: EnqueueInput[] = [];
  setActiveCalls: Array<{ id: string; active: boolean }> = [];
  clearCalls: string[] = [];
  supersededJobIds: string[] = [];
  jobCounter = 0;

  async ensureRepo(repo: RepoRef): Promise<string> {
    return `repo:${repo.owner}/${repo.name}`;
  }

  async upsertPullRequest(input: UpsertPullRequestInput): Promise<string> {
    this.upserts.push(input);
    return `pr:${input.repoId}#${input.number}`;
  }

  async setReviewActive(id: string, active: boolean): Promise<void> {
    this.setActiveCalls.push({ id, active });
  }

  async clearOnClose(id: string): Promise<void> {
    this.clearCalls.push(id);
  }

  async enqueueReviewJob(input: EnqueueInput): Promise<string> {
    this.enqueued.push(input);
    this.jobCounter += 1;
    return `job:${this.jobCounter}`;
  }

  async enqueueSupersedingReviewJob(input: EnqueueInput): Promise<EnqueueSupersedingResult> {
    this.supersedingEnqueues.push(input);
    this.jobCounter += 1;
    return {
      reviewJobId: `job:${this.jobCounter}`,
      supersededJobIds: this.supersededJobIds,
      enqueued: true,
    };
  }
}

class FakeForkDeclineCommenter {
  readonly comments: Array<{ repo: RepoRef; pullNumber: number; body: string }> = [];

  async postForkDeclined(input: {
    repo: RepoRef;
    pullNumber: number;
    body: string;
  }): Promise<void> {
    this.comments.push(input);
  }
}

function comment(body: string, prOverrides: Partial<PullRequestFacts> = {}): CommentEvent {
  return {
    kind: 'comment',
    repo: BASE_REPO,
    commentKind: 'issue_comment',
    body,
    pr: prFacts(prOverrides),
  };
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

function checkRun(prOverrides: Partial<PullRequestFacts> = {}): CheckRunEvent {
  return { kind: 'check_run', repo: BASE_REPO, pr: prFacts(prOverrides) };
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
    const sink = new FakeSink();
    const outcome = await dispatchEvent(pr('opened'), sink, silentLogger);
    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(sink.upserts).toHaveLength(1);
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
  });

  // AC: @bot review enqueues a ReviewJob (superseding any in-flight one) and
  // flips reviewActive=true.
  it('@bot review enqueues a logic job through the superseding path and flips reviewActive', async () => {
    const sink = new FakeSink();
    const outcome = await dispatchEvent(comment('@bot review'), sink, silentLogger);
    expect(outcome).toMatchObject({ action: 'enqueued', trigger: 'mention' });
    expect(sink.setActiveCalls).toEqual([{ id: 'pr:repo:tony-co/sandy#7', active: true }]);
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.supersedingEnqueues).toEqual([
      {
        pullRequestId: 'pr:repo:tony-co/sandy#7',
        repoId: 'repo:tony-co/sandy',
        headSha: 'sha-7',
        trigger: 'mention',
        agentKeys: ['logic'],
      },
    ]);
  });

  // The enqueued ReviewJob carries the Repo's configured candidate Agents, not a
  // hardcoded Agent, so the persisted record matches what the worker will fan out.
  it('enqueues the configured candidate Agents from the injected resolver', async () => {
    const sink = new FakeSink();
    const resolveAgentKeys = vi.fn(() => ['logic', 'convex', 'security']);
    const outcome = await dispatchEvent(comment('@bot review'), sink, silentLogger, {
      resolveAgentKeys,
    });
    expect(outcome).toMatchObject({ action: 'enqueued', trigger: 'mention' });
    expect(resolveAgentKeys).toHaveBeenCalledWith(BASE_REPO);
    expect(sink.supersedingEnqueues[0]?.agentKeys).toEqual(['logic', 'convex', 'security']);
  });

  // The same resolver drives the Re-run path's superseding enqueue.
  it('threads the resolver result through the superseding re-run enqueue', async () => {
    const sink = new FakeSink();
    const outcome = await dispatchEvent(checkRun(), sink, silentLogger, {
      resolveAgentKeys: () => ['logic', 'nextjs'],
    });
    expect(outcome).toMatchObject({ action: 'enqueued', trigger: 'rerun' });
    expect(sink.supersedingEnqueues[0]?.agentKeys).toEqual(['logic', 'nextjs']);
  });

  // An unregistered Repo resolves to no Agents; preserve that rather than masking
  // it with a logic fallback (the worker would resolve no Agents for it too).
  it('preserves an empty resolver result instead of falling back to logic', async () => {
    const sink = new FakeSink();
    const outcome = await dispatchEvent(comment('@bot review'), sink, silentLogger, {
      resolveAgentKeys: () => [],
    });
    expect(outcome).toMatchObject({ action: 'enqueued' });
    expect(sink.supersedingEnqueues[0]?.agentKeys).toEqual([]);
  });

  // Manual-only triggering: a push delivered as a `synchronize` PR event never
  // re-reviews the PR, opted in or not.
  it('does nothing on synchronize', async () => {
    const sink = new FakeSink();
    const outcome = await dispatchEvent(pr('synchronize'), sink, silentLogger);
    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.supersedingEnqueues).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
  });

  // draft → ready no longer auto-reviews; the author runs `@bot review` instead.
  it('does nothing on ready_for_review', async () => {
    const sink = new FakeSink();
    const outcome = await dispatchEvent(pr('ready_for_review'), sink, silentLogger);
    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.supersedingEnqueues).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
  });

  // AC: PR close clears reviewActive.
  it('close clears reviewActive and enqueues nothing', async () => {
    const sink = new FakeSink();
    const outcome = await dispatchEvent(pr('closed'), sink, silentLogger);
    expect(outcome).toMatchObject({ action: 'cleared' });
    expect(sink.clearCalls).toEqual(['pr:repo:tony-co/sandy#7']);
    expect(sink.enqueued).toHaveLength(0);
    // The PR row is upserted with closed state before the flag is cleared.
    expect(sink.upserts[0]?.state).toBe('closed');
  });

  it('captures bot comment reactions when a PR closes', async () => {
    const sink = new FakeSink();
    const captured: Array<{
      repo: RepoRef;
      pullNumber: number;
      pullRequestId: string;
      state: PullRequestFacts['state'];
    }> = [];

    const outcome = await dispatchEvent(pr('closed'), sink, silentLogger, {
      closeSignalCapturer: {
        async capturePrCloseSignals(input) {
          captured.push(input);
          return { recorded: 1 };
        },
      },
    });

    expect(outcome).toMatchObject({ action: 'cleared' });
    expect(captured).toEqual([
      {
        repo: BASE_REPO,
        pullNumber: 7,
        pullRequestId: 'pr:repo:tony-co/sandy#7',
        state: 'closed',
      },
    ]);
    expect(sink.clearCalls).toEqual(['pr:repo:tony-co/sandy#7']);
  });

  it('passes the PR lifecycle state to the close-time signal pass', async () => {
    const sink = new FakeSink();
    const captured: Array<{ state: PullRequestFacts['state'] }> = [];

    await dispatchEvent(pr('closed', { state: 'merged' }), sink, silentLogger, {
      closeSignalCapturer: {
        async capturePrCloseSignals(input) {
          captured.push({ state: input.state });
          return { recorded: 0 };
        },
      },
    });

    expect(captured).toEqual([{ state: 'merged' }]);
    expect(sink.upserts[0]?.state).toBe('merged');
  });

  it('captures reply feedback for a review-comment reply without enqueuing a review', async () => {
    const sink = new FakeSink();
    const replies: Array<{
      repo: RepoRef;
      pullNumber: number;
      pullRequestId: string;
      comment: { id: number; body: string; inReplyToId?: number };
    }> = [];

    const outcome = await dispatchEvent(
      {
        ...comment('This finding is not useful.'),
        commentKind: 'pull_request_review_comment',
        githubCommentId: 303,
        inReplyToId: 101,
      },
      sink,
      silentLogger,
      {
        replyCapturer: {
          async captureCommentReply(input) {
            replies.push(input);
            return { recorded: 1 };
          },
        },
      },
    );

    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(replies).toEqual([
      {
        repo: BASE_REPO,
        pullNumber: 7,
        pullRequestId: 'pr:repo:tony-co/sandy#7',
        comment: {
          id: 303,
          body: 'This finding is not useful.',
          inReplyToId: 101,
        },
      },
    ]);
    expect(sink.enqueued).toHaveLength(0);
  });

  it('does not send PR Conversation comments to the reply capturer', async () => {
    const sink = new FakeSink();
    const replies: unknown[] = [];

    await dispatchEvent(
      {
        ...comment('Top-level PR comment'),
        commentKind: 'issue_comment',
        githubCommentId: 303,
      },
      sink,
      silentLogger,
      {
        replyCapturer: {
          async captureCommentReply(input) {
            replies.push(input);
            return { recorded: 1 };
          },
        },
      },
    );

    expect(replies).toEqual([]);
  });

  // AC: a fork PR is declined with a documented-limitation message, not reviewed.
  it('declines a fork PR on mention without upserting or enqueuing', async () => {
    const warn = vi.fn();
    const sink = new FakeSink();
    const commenter = new FakeForkDeclineCommenter();
    const outcome = await dispatchEvent(
      comment('@bot review', { headRepo: { owner: 'forker', name: 'sandy' } }),
      sink,
      { info: vi.fn(), warn },
      { forkDeclineCommenter: commenter },
    );
    expect(outcome).toEqual({ action: 'declined-fork', repo: 'tony-co/sandy', number: 7 });
    expect(sink.upserts).toHaveLength(0);
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
    expect(commenter.comments).toEqual([
      { repo: BASE_REPO, pullNumber: 7, body: FORK_DECLINE_MESSAGE },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(FORK_DECLINE_MESSAGE));
  });

  it('still declines a fork PR when posting the courtesy comment fails', async () => {
    const warn = vi.fn();
    const sink = new FakeSink();
    const outcome = await dispatchEvent(
      comment('@bot review', { headRepo: { owner: 'forker', name: 'sandy' } }),
      sink,
      { info: vi.fn(), warn },
      {
        forkDeclineCommenter: {
          async postForkDeclined() {
            throw new Error('rate limited');
          },
        },
      },
    );

    expect(outcome).toEqual({ action: 'declined-fork', repo: 'tony-co/sandy', number: 7 });
    expect(sink.upserts).toHaveLength(0);
    expect(sink.enqueued).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to post fork-decline comment'),
      expect.any(Error),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(FORK_DECLINE_MESSAGE));
  });

  it('does nothing on a direct push event', async () => {
    const sink = new FakeSink();
    const outcome = await dispatchEvent(push(), sink, silentLogger);
    expect(outcome).toEqual({ action: 'noop', reason: 'no trigger' });
    expect(sink.enqueued).toHaveLength(0);
    expect(sink.supersedingEnqueues).toHaveLength(0);
    expect(sink.setActiveCalls).toHaveLength(0);
  });

  it('enqueues a Check Run re-run through the superseding path even when opted out', async () => {
    const sink = new FakeSink();
    sink.supersededJobIds = ['job:old-running'];
    const cancelled: string[][] = [];

    const outcome = await dispatchEvent(checkRun({ headSha: 'current-sha' }), sink, silentLogger, {
      reviewCanceller: {
        cancelReviewJobs(jobIds) {
          cancelled.push(jobIds);
        },
      },
    });

    expect(outcome).toEqual({
      action: 'enqueued',
      reviewJobId: 'job:1',
      trigger: 'rerun',
      supersededJobIds: ['job:old-running'],
    });
    expect(sink.setActiveCalls).toEqual([{ id: 'pr:repo:tony-co/sandy#7', active: true }]);
    expect(sink.enqueued).toEqual([]);
    expect(sink.supersedingEnqueues).toEqual([
      {
        pullRequestId: 'pr:repo:tony-co/sandy#7',
        repoId: 'repo:tony-co/sandy',
        headSha: 'current-sha',
        trigger: 'rerun',
        agentKeys: ['logic'],
      },
    ]);
    expect(cancelled).toEqual([['job:old-running']]);
  });

  it('supersedes active stale jobs and requests cancellation before returning a re-run enqueue', async () => {
    const sink = new FakeSink();
    sink.supersededJobIds = ['job:old-running', 'job:old-pending'];
    const cancelled: string[][] = [];

    const outcome = await dispatchEvent(checkRun(), sink, silentLogger, {
      reviewCanceller: {
        cancelReviewJobs(jobIds) {
          cancelled.push(jobIds);
        },
      },
    });

    expect(outcome).toEqual({
      action: 'enqueued',
      reviewJobId: 'job:1',
      trigger: 'rerun',
      supersededJobIds: ['job:old-running', 'job:old-pending'],
    });
    expect(sink.enqueued).toEqual([]);
    expect(sink.supersedingEnqueues).toEqual([
      {
        pullRequestId: 'pr:repo:tony-co/sandy#7',
        repoId: 'repo:tony-co/sandy',
        headSha: 'sha-7',
        trigger: 'rerun',
        agentKeys: ['logic'],
      },
    ]);
    expect(cancelled).toEqual([['job:old-running', 'job:old-pending']]);
  });

  // Finding #3: a mention on a closed PR must not enqueue, must not flip
  // reviewActive, and must not clobber the stored state back to 'open'.
  it('does not enqueue or re-arm on an @bot review mention on a closed PR', async () => {
    const sink = new FakeSink();
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
    const sink = new FakeSink();
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
    const sink = new FakeSink();
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
