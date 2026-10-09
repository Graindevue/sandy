import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../github/types.js';
import type {
  ReactionCaptureComment,
  ReactionCaptureGitHub,
  ReactionCaptureStore,
  ReactionTarget,
  RecordedReactionInput,
} from './reaction-capture.js';
import { captureCommentReply } from './reply-handler.js';

const repo: RepoRef = { owner: 'acme', name: 'widget' };

describe('captureCommentReply', () => {
  it('records reply text through the stored parent GitHub comment id', async () => {
    const store = new FakeReplyStore([{ findingId: 'finding-1', githubCommentId: 101 }]);
    const github = new FakeReplyGitHub();

    const result = await captureCommentReply({
      repo,
      pullNumber: 12,
      pullRequestId: 'pr-1',
      comment: {
        id: 303,
        body: 'This is noisy because the fixture already covers it.',
        inReplyToId: 101,
      },
      store,
      github,
    });

    expect(result).toEqual({ recorded: 1 });
    expect(store.recorded).toEqual([
      {
        findingId: 'finding-1',
        kind: 'reply',
        replyText: 'This is noisy because the fixture already covers it.',
      },
    ]);
    expect(github.commentListRequests).toEqual([]);
  });

  it('falls back to the finding trailer on the parent comment', async () => {
    const store = new FakeReplyStore([{ findingId: 'finding-1' }]);
    const github = new FakeReplyGitHub([
      {
        id: 101,
        body: 'Sandy finding\n\n<!-- bot:finding=finding-1 archetype=archetype-1 -->',
        kind: 'pull_request_review_comment',
      },
    ]);

    const result = await captureCommentReply({
      repo,
      pullNumber: 12,
      pullRequestId: 'pr-1',
      comment: {
        id: 303,
        body: 'The proposed fix is not actionable.',
        inReplyToId: 101,
      },
      store,
      github,
    });

    expect(result).toEqual({ recorded: 1 });
    expect(store.recorded).toEqual([
      {
        findingId: 'finding-1',
        kind: 'reply',
        replyText: 'The proposed fix is not actionable.',
      },
    ]);
    expect(github.commentListRequests).toEqual([{ repo, pullNumber: 12 }]);
  });

  it('ignores replies under non-Sandy comments', async () => {
    const store = new FakeReplyStore([{ findingId: 'finding-1' }]);
    const github = new FakeReplyGitHub([
      {
        id: 101,
        body: 'Human review comment',
        kind: 'pull_request_review_comment',
      },
    ]);

    const result = await captureCommentReply({
      repo,
      pullNumber: 12,
      pullRequestId: 'pr-1',
      comment: {
        id: 303,
        body: 'I agree with this thread.',
        inReplyToId: 101,
      },
      store,
      github,
    });

    expect(result).toEqual({ recorded: 0 });
    expect(store.recorded).toEqual([]);
  });

  it('ignores top-level comments', async () => {
    const store = new FakeReplyStore([{ findingId: 'finding-1', githubCommentId: 101 }]);
    const github = new FakeReplyGitHub();

    const result = await captureCommentReply({
      repo,
      pullNumber: 12,
      pullRequestId: 'pr-1',
      comment: {
        id: 303,
        body: 'Top-level PR review comment',
      },
      store,
      github,
    });

    expect(result).toEqual({ recorded: 0 });
    expect(store.listedTargets).toBe(false);
    expect(github.commentListRequests).toEqual([]);
  });
});

class FakeReplyStore implements ReactionCaptureStore {
  readonly recorded: RecordedReactionInput[] = [];
  listedTargets = false;

  constructor(private readonly targets: ReactionTarget[]) {}

  async listReactionTargetsForPr(): Promise<ReactionTarget[]> {
    this.listedTargets = true;
    return this.targets;
  }

  async recordReaction(input: RecordedReactionInput): Promise<void> {
    this.recorded.push(input);
  }
}

class FakeReplyGitHub implements Pick<ReactionCaptureGitHub, 'listReactionCaptureComments'> {
  readonly commentListRequests: Array<{ repo: RepoRef; pullNumber: number }> = [];

  constructor(private readonly comments: ReactionCaptureComment[] = []) {}

  async listReactionCaptureComments(input: {
    repo: RepoRef;
    pullNumber: number;
  }): Promise<ReactionCaptureComment[]> {
    this.commentListRequests.push(input);
    return this.comments;
  }
}
