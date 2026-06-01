import { describe, expect, it } from 'vitest';
import { GitHubAppClient } from './app-client.js';

describe('GitHubAppClient', () => {
  it('counts changed lines across PR files', async () => {
    const requests: string[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
        signals.push(init?.signal);
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        if (String(url).endsWith('/app/installations/42/access_tokens')) {
          return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
        }
        return jsonResponse([
          { additions: 10, deletions: 2 },
          { additions: 3, deletions: 4 },
        ]);
      },
    });

    await expect(
      client.changedLineCount({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 12,
        headSha: 'abc123',
      }),
    ).resolves.toBe(19);
    expect(requests).toContain(
      'GET https://api.github.com/repos/acme/widget/pulls/12/files?per_page=100&page=1',
    );
    expect(signals).not.toHaveLength(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('excludes ignored PR files from changed line counts', async () => {
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url) => {
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        if (String(url).endsWith('/app/installations/42/access_tokens')) {
          return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
        }
        return jsonResponse([
          { filename: 'generated/api.ts', additions: 100, deletions: 25 },
          { filename: 'src/widget.ts', additions: 4, deletions: 1 },
          { filename: 'tests/widget.snap', additions: 30, deletions: 0 },
        ]);
      },
    });

    await expect(
      client.changedLineCount(
        {
          owner: 'acme',
          repo: 'widget',
          pullNumber: 12,
          headSha: 'abc123',
        },
        ['generated/**', '*.snap'],
      ),
    ).resolves.toBe(5);
  });

  it('builds authenticated clone URLs from installation tokens', async () => {
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url) => {
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        return jsonResponse({ token: 'token/value', expires_at: '2099-01-01T00:00:00Z' });
      },
    });

    await expect(client.cloneUrlForRepo({ owner: 'acme', name: 'widget' })).resolves.toBe(
      'https://x-access-token:token%2Fvalue@github.com/acme/widget.git',
    );
  });

  it('resolves pull request facts for issue_comment hydration', async () => {
    const requests: string[] = [];
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        if (String(url).endsWith('/app/installations/42/access_tokens')) {
          return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
        }
        return jsonResponse({
          number: 12,
          draft: false,
          title: 'Fix cache key',
          html_url: 'https://github.com/acme/widget/pull/12',
          state: 'closed',
          merged: true,
          user: { login: 'octocat' },
          head: {
            sha: 'abc123',
            repo: { owner: { login: 'acme' }, name: 'widget' },
          },
          base: { ref: 'main' },
        });
      },
    });

    await expect(client.resolvePullRequest({ owner: 'acme', name: 'widget' }, 12)).resolves.toEqual(
      {
        number: 12,
        draft: false,
        headSha: 'abc123',
        baseRef: 'main',
        title: 'Fix cache key',
        author: 'octocat',
        url: 'https://github.com/acme/widget/pull/12',
        state: 'merged',
        headRepo: { owner: 'acme', name: 'widget' },
      },
    );
    expect(requests).toContain('GET https://api.github.com/repos/acme/widget/pulls/12');
  });

  it('resolves a push branch and head SHA to its open pull request', async () => {
    const requests: string[] = [];
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        if (String(url).endsWith('/app/installations/42/access_tokens')) {
          return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
        }
        return jsonResponse([
          {
            number: 12,
            draft: false,
            title: 'Fix cache key',
            html_url: 'https://github.com/acme/widget/pull/12',
            state: 'open',
            merged: false,
            user: { login: 'octocat' },
            head: {
              sha: 'old-sha',
              repo: { owner: { login: 'acme' }, name: 'widget' },
            },
            base: { ref: 'main' },
          },
          {
            number: 13,
            draft: false,
            title: 'Fix cache key again',
            html_url: 'https://github.com/acme/widget/pull/13',
            state: 'open',
            merged: false,
            user: { login: 'octocat' },
            head: {
              sha: 'abc123',
              repo: { owner: { login: 'acme' }, name: 'widget' },
            },
            base: { ref: 'main' },
          },
        ]);
      },
    });

    await expect(
      client.resolvePullRequestForPush(
        { owner: 'acme', name: 'widget' },
        'feature/cache',
        'abc123',
      ),
    ).resolves.toMatchObject({
      number: 13,
      headSha: 'abc123',
      headRepo: { owner: 'acme', name: 'widget' },
    });
    expect(requests).toContain(
      'GET https://api.github.com/repos/acme/widget/pulls?state=open&head=acme%3Afeature%2Fcache',
    );
  });

  it('lists PR review comments and their reactions for close-time capture', async () => {
    const requests: string[] = [];
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        if (String(url).endsWith('/app/installations/42/access_tokens')) {
          return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
        }
        if (String(url).endsWith('/repos/acme/widget/pulls/12/comments?per_page=100&page=1')) {
          return jsonResponse([{ id: 101, body: '<!-- bot:finding=finding-1 -->' }]);
        }
        return jsonResponse([{ content: '-1' }, { content: 'laugh' }]);
      },
    });

    await expect(
      client.listPullRequestReviewComments({
        repo: { owner: 'acme', name: 'widget' },
        pullNumber: 12,
      }),
    ).resolves.toEqual([{ id: 101, body: '<!-- bot:finding=finding-1 -->' }]);
    await expect(
      client.listCommentReactions({
        repo: { owner: 'acme', name: 'widget' },
        commentId: 101,
        commentKind: 'pull_request_review_comment',
      }),
    ).resolves.toEqual([{ content: '-1' }, { content: 'laugh' }]);
    expect(requests).toContain(
      'GET https://api.github.com/repos/acme/widget/pulls/comments/101/reactions?per_page=100&page=1',
    );
  });

  it('falls back to issue comment reactions when a stored comment id is not a review comment', async () => {
    const requests: string[] = [];
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        if (String(url).endsWith('/app/installations/42/access_tokens')) {
          return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
        }
        if (String(url).includes('/pulls/comments/202/reactions')) {
          return jsonResponse({ message: 'Not Found' }, 404);
        }
        return jsonResponse([{ content: '+1' }]);
      },
    });

    await expect(
      client.listCommentReactions({
        repo: { owner: 'acme', name: 'widget' },
        commentId: 202,
      }),
    ).resolves.toEqual([{ content: '+1' }]);
    expect(requests).toContain(
      'GET https://api.github.com/repos/acme/widget/pulls/comments/202/reactions?per_page=100&page=1',
    );
    expect(requests).toContain(
      'GET https://api.github.com/repos/acme/widget/issues/comments/202/reactions?per_page=100&page=1',
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
