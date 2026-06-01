import { describe, expect, it } from 'vitest';
import {
  type CommentReaction,
  capturePrCloseReactions,
  type ReactionCaptureComment,
  type ReactionCaptureGitHub,
  type ReactionCaptureStore,
  type ReactionTarget,
} from './reaction-capture.js';

describe('capturePrCloseReactions', () => {
  it('records a thumbs-down reaction through the stored GitHub comment id', async () => {
    const store = new FakeReactionStore([{ findingId: 'finding-1', githubCommentId: 101 }]);
    const github = new FakeReactionGitHub({
      reviewComments: [{ id: 101, body: 'Sandy finding comment' }],
      reactionsByCommentId: new Map([[101, [{ content: '-1' }]]]),
    });

    await capturePrCloseReactions({
      repo: { owner: 'acme', name: 'widget' },
      pullNumber: 12,
      pullRequestId: 'pr-1',
      store,
      github,
    });

    expect(store.recorded).toEqual([{ findingId: 'finding-1', kind: '👎' }]);
  });

  it('records a thumbs-up reaction through the stored GitHub comment id', async () => {
    const store = new FakeReactionStore([{ findingId: 'finding-1', githubCommentId: 101 }]);
    const github = new FakeReactionGitHub({
      reviewComments: [{ id: 101, body: 'Sandy finding comment' }],
      reactionsByCommentId: new Map([[101, [{ content: '+1' }]]]),
    });

    await capturePrCloseReactions({
      repo: { owner: 'acme', name: 'widget' },
      pullNumber: 12,
      pullRequestId: 'pr-1',
      store,
      github,
    });

    expect(store.recorded).toEqual([{ findingId: 'finding-1', kind: '👍' }]);
  });

  it('falls back to the finding trailer when the stored comment id is missing', async () => {
    const store = new FakeReactionStore([{ findingId: 'finding-1' }]);
    const github = new FakeReactionGitHub({
      issueComments: [{ id: 202, body: 'Summary\n\n<!-- bot:finding=finding-1 -->' }],
      reactionsByCommentId: new Map([[202, [{ content: '-1' }]]]),
    });

    await capturePrCloseReactions({
      repo: { owner: 'acme', name: 'widget' },
      pullNumber: 12,
      pullRequestId: 'pr-1',
      store,
      github,
    });

    expect(store.recorded).toEqual([{ findingId: 'finding-1', kind: '👎' }]);
  });

  it('records nothing when Sandy comments have no thumbs reactions', async () => {
    const store = new FakeReactionStore([{ findingId: 'finding-1', githubCommentId: 101 }]);
    const github = new FakeReactionGitHub({
      reviewComments: [{ id: 101, body: '<!-- bot:finding=finding-1 -->' }],
      reactionsByCommentId: new Map([[101, [{ content: 'laugh' }]]]),
    });

    const result = await capturePrCloseReactions({
      repo: { owner: 'acme', name: 'widget' },
      pullNumber: 12,
      pullRequestId: 'pr-1',
      store,
      github,
    });

    expect(result).toEqual({ recorded: 0 });
    expect(store.recorded).toEqual([]);
  });
});

class FakeReactionStore implements ReactionCaptureStore {
  readonly recorded: Array<{ findingId: string; kind: '👍' | '👎' }> = [];

  constructor(private readonly targets: ReactionTarget[]) {}

  async listReactionTargetsForPr(): Promise<ReactionTarget[]> {
    return this.targets;
  }

  async recordReaction(input: { findingId: string; kind: '👍' | '👎' }): Promise<void> {
    this.recorded.push(input);
  }
}

class FakeReactionGitHub implements ReactionCaptureGitHub {
  readonly reviewComments: ReactionCaptureComment[];
  readonly issueComments: ReactionCaptureComment[];
  readonly reactionsByCommentId: Map<number, CommentReaction[]>;

  constructor(options: {
    reviewComments?: ReactionCaptureComment[];
    issueComments?: ReactionCaptureComment[];
    reactionsByCommentId?: Map<number, CommentReaction[]>;
  }) {
    this.reviewComments = options.reviewComments ?? [];
    this.issueComments = options.issueComments ?? [];
    this.reactionsByCommentId = options.reactionsByCommentId ?? new Map();
  }

  async listPullRequestReviewComments(): Promise<ReactionCaptureComment[]> {
    return this.reviewComments;
  }

  async listIssueComments(): Promise<ReactionCaptureComment[]> {
    return this.issueComments;
  }

  async listCommentReactions(input: { commentId: number }): Promise<CommentReaction[]> {
    return this.reactionsByCommentId.get(input.commentId) ?? [];
  }
}
