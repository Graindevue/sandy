import { describe, expect, it } from 'vitest';
import { captureCommentReply } from './reply-handler.js';

describe('captureCommentReply', () => {
  it('records reply text through the stored parent GitHub comment id', async () => {
    const recorded: Array<{ findingId: string; kind: string; replyText?: string }> = [];
    const store = {
      async listReactionTargetsForPr() {
        return [{ findingId: 'finding-1', githubCommentId: 101 }];
      },
      async recordReaction(input: { findingId: string; kind: string; replyText?: string }) {
        recorded.push(input);
      },
    };
    const commentListRequests: Array<{
      repo: { owner: string; name: string };
      pullNumber: number;
    }> = [];
    const github = {
      async listReactionCaptureComments(input: {
        repo: { owner: string; name: string };
        pullNumber: number;
      }) {
        commentListRequests.push(input);
        return [];
      },
    };

    const result = await captureCommentReply({
      repo: { owner: 'acme', name: 'widget' },
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
    expect(recorded).toEqual([
      {
        findingId: 'finding-1',
        kind: 'reply',
        replyText: 'This is noisy because the fixture already covers it.',
      },
    ]);
    expect(commentListRequests).toEqual([]);
  });

  it('falls back to the finding trailer on the parent comment', async () => {
    const recorded: Array<{ findingId: string; kind: string; replyText?: string }> = [];
    const store = {
      async listReactionTargetsForPr() {
        return [{ findingId: 'finding-1' }];
      },
      async recordReaction(input: { findingId: string; kind: string; replyText?: string }) {
        recorded.push(input);
      },
    };
    const commentListRequests: Array<{
      repo: { owner: string; name: string };
      pullNumber: number;
    }> = [];
    const github = {
      async listReactionCaptureComments(input: {
        repo: { owner: string; name: string };
        pullNumber: number;
      }) {
        commentListRequests.push(input);
        return [
          {
            id: 101,
            body: 'Sandy finding\n\n<!-- bot:finding=finding-1 archetype=archetype-1 -->',
            kind: 'pull_request_review_comment' as const,
          },
        ];
      },
    };

    const result = await captureCommentReply({
      repo: { owner: 'acme', name: 'widget' },
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
    expect(recorded).toEqual([
      {
        findingId: 'finding-1',
        kind: 'reply',
        replyText: 'The proposed fix is not actionable.',
      },
    ]);
    expect(commentListRequests).toEqual([
      { repo: { owner: 'acme', name: 'widget' }, pullNumber: 12 },
    ]);
  });

  it('ignores replies under non-Sandy comments', async () => {
    const recorded: Array<{ findingId: string; kind: string; replyText?: string }> = [];
    const store = {
      async listReactionTargetsForPr() {
        return [{ findingId: 'finding-1' }];
      },
      async recordReaction(input: { findingId: string; kind: string; replyText?: string }) {
        recorded.push(input);
      },
    };
    const github = {
      async listReactionCaptureComments() {
        return [
          {
            id: 101,
            body: 'Human review comment',
            kind: 'pull_request_review_comment' as const,
          },
        ];
      },
    };

    const result = await captureCommentReply({
      repo: { owner: 'acme', name: 'widget' },
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
    expect(recorded).toEqual([]);
  });

  it('ignores top-level comments', async () => {
    let listedTargets = false;
    const store = {
      async listReactionTargetsForPr() {
        listedTargets = true;
        return [{ findingId: 'finding-1', githubCommentId: 101 }];
      },
      async recordReaction() {
        throw new Error('should not record a top-level comment');
      },
    };
    const github = {
      async listReactionCaptureComments() {
        throw new Error('should not fetch comments for a top-level comment');
      },
    };

    const result = await captureCommentReply({
      repo: { owner: 'acme', name: 'widget' },
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
    expect(listedTargets).toBe(false);
  });
});
