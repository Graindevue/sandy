import { describe, expect, it } from 'vitest';
import {
  type CommentReaction,
  capturePrCloseReactions,
  type ListCommentReactionsInput,
  type ReactionCaptureComment,
  type ReactionCaptureGitHub,
  type ReactionCaptureStore,
  type ReactionTarget,
  type RecordedReactionInput,
} from './reaction-capture.js';

describe('capturePrCloseReactions', () => {
  it('records a thumbs-down reaction through the stored GitHub comment id', async () => {
    const store = new FakeReactionStore([{ findingId: 'finding-1', githubCommentId: 101 }]);
    const github = new FakeReactionGitHub({
      comments: [{ id: 101, body: 'Sandy finding comment', kind: 'pull_request_review_comment' }],
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
    expect(github.reactionRequests).toEqual([
      {
        repo: { owner: 'acme', name: 'widget' },
        commentId: 101,
        commentKind: 'pull_request_review_comment',
      },
    ]);
  });

  it('records a thumbs-up reaction through the stored GitHub comment id', async () => {
    const store = new FakeReactionStore([{ findingId: 'finding-1', githubCommentId: 101 }]);
    const github = new FakeReactionGitHub({
      comments: [{ id: 101, body: 'Sandy finding comment', kind: 'pull_request_review_comment' }],
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
      comments: [
        {
          id: 202,
          body: 'Summary\n\n<!-- bot:finding=finding-1 -->',
          kind: 'issue_comment',
        },
      ],
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
    expect(github.reactionRequests).toEqual([
      {
        repo: { owner: 'acme', name: 'widget' },
        commentId: 202,
        commentKind: 'issue_comment',
      },
    ]);
  });

  it('records nothing when Sandy comments have no thumbs reactions', async () => {
    const store = new FakeReactionStore([{ findingId: 'finding-1', githubCommentId: 101 }]);
    const github = new FakeReactionGitHub({
      comments: [
        {
          id: 101,
          body: '<!-- bot:finding=finding-1 -->',
          kind: 'pull_request_review_comment',
        },
      ],
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
  readonly recorded: RecordedReactionInput[] = [];

  constructor(private readonly targets: ReactionTarget[]) {}

  async listReactionTargetsForPr(): Promise<ReactionTarget[]> {
    return this.targets;
  }

  async recordReaction(input: RecordedReactionInput): Promise<void> {
    this.recorded.push(input);
  }
}

class FakeReactionGitHub implements ReactionCaptureGitHub {
  readonly comments: ReactionCaptureComment[];
  readonly reactionsByCommentId: Map<number, CommentReaction[]>;
  readonly reactionRequests: ListCommentReactionsInput[] = [];

  constructor(options: {
    comments?: ReactionCaptureComment[];
    reactionsByCommentId?: Map<number, CommentReaction[]>;
  }) {
    this.comments = options.comments ?? [];
    this.reactionsByCommentId = options.reactionsByCommentId ?? new Map();
  }

  async listReactionCaptureComments(): Promise<ReactionCaptureComment[]> {
    return this.comments;
  }

  async listCommentReactions(input: ListCommentReactionsInput): Promise<CommentReaction[]> {
    this.reactionRequests.push(input);
    return this.reactionsByCommentId.get(input.commentId) ?? [];
  }
}
