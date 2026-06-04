import { describe, expect, it } from 'vitest';
import { GitHubAppClient } from './app-client.js';

describe('GitHubAppClient', () => {
  it('creates and completes the Sandy Check Run', async () => {
    const requests: Array<{ request: string; body: unknown }> = [];
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url, init) => {
        const request = `${init?.method ?? 'GET'} ${String(url)}`;
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        requests.push({ request, body });
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        if (String(url).endsWith('/app/installations/42/access_tokens')) {
          return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
        }
        if (String(url).endsWith('/repos/acme/widget/check-runs')) {
          return jsonResponse({ id: 1200 }, 201);
        }
        if (String(url).endsWith('/repos/acme/widget/check-runs/1200')) {
          return jsonResponse({ id: 1200 });
        }
        return jsonResponse({ message: `unexpected ${request}` }, 500);
      },
    });

    await expect(
      client.createInProgress({
        owner: 'acme',
        repo: 'widget',
        headSha: 'abc123',
        pullRequestUrl: 'https://github.com/acme/widget/pull/12',
        startedAt: Date.parse('2026-06-04T10:00:00Z'),
      }),
    ).resolves.toEqual({ id: 1200 });

    await expect(
      client.complete({
        owner: 'acme',
        repo: 'widget',
        checkRunId: 1200,
        conclusion: 'neutral',
        detailsUrl: 'https://github.com/acme/widget/pull/12#issuecomment-900',
        summaryCommentUrl: 'https://github.com/acme/widget/pull/12#issuecomment-900',
        verdict: 'Sandy posted 1 finding',
        completedAt: Date.parse('2026-06-04T10:01:00Z'),
      }),
    ).resolves.toBeUndefined();

    expect(requests).toEqual(
      expect.arrayContaining([
        {
          request: 'POST https://api.github.com/repos/acme/widget/check-runs',
          body: {
            name: 'Sandy',
            head_sha: 'abc123',
            status: 'in_progress',
            details_url: 'https://github.com/acme/widget/pull/12',
            started_at: '2026-06-04T10:00:00.000Z',
            output: {
              title: 'Sandy review',
              summary: 'Sandy review is running.',
            },
          },
        },
        {
          request: 'PATCH https://api.github.com/repos/acme/widget/check-runs/1200',
          body: {
            name: 'Sandy',
            status: 'completed',
            conclusion: 'neutral',
            details_url: 'https://github.com/acme/widget/pull/12#issuecomment-900',
            completed_at: '2026-06-04T10:01:00.000Z',
            output: {
              title: 'Sandy review',
              summary:
                'Sandy posted 1 finding. [View summary](https://github.com/acme/widget/pull/12#issuecomment-900).',
            },
          },
        },
      ]),
    );
  });

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

  it('opens a product-rules pull request from a SuggestedRule', async () => {
    const requests: Array<{ request: string; body: unknown }> = [];
    const client = new GitHubAppClient({
      appId: '123',
      privateKey: 'unused',
      createJwt: () => 'app-jwt',
      fetch: async (url, init) => {
        const request = `${init?.method ?? 'GET'} ${String(url)}`;
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        requests.push({ request, body });
        if (String(url).endsWith('/repos/acme/widget/installation')) {
          return jsonResponse({ id: 42 });
        }
        if (String(url).endsWith('/app/installations/42/access_tokens')) {
          return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
        }
        if (String(url).endsWith('/repos/acme/widget/git/ref/heads/main')) {
          return jsonResponse({ object: { sha: 'base-sha' } });
        }
        if (String(url).endsWith('/repos/acme/widget/git/refs')) {
          return jsonResponse({ ref: 'refs/heads/sandy/suggested-rule-suggestedRules-2' }, 201);
        }
        if (
          String(url).endsWith(
            '/repos/acme/widget/contents/.bot/product-rules.md?ref=sandy%2Fsuggested-rule-suggestedRules-2',
          )
        ) {
          return jsonResponse({
            type: 'file',
            sha: 'rules-sha',
            encoding: 'base64',
            content: Buffer.from('- Existing product rule.\n').toString('base64'),
          });
        }
        if (String(url).endsWith('/repos/acme/widget/contents/.bot/product-rules.md')) {
          return jsonResponse({ commit: { sha: 'promotion-sha' } });
        }
        if (
          String(url).endsWith(
            '/repos/acme/widget/pulls?state=open&head=acme%3Asandy%2Fsuggested-rule-suggestedRules-2',
          )
        ) {
          return jsonResponse([]);
        }
        if (String(url).endsWith('/repos/acme/widget/pulls')) {
          return jsonResponse({
            number: 45,
            draft: false,
            title: 'Add product rule from SuggestedRule suggestedRules:2',
            html_url: 'https://github.com/acme/widget/pull/45',
            state: 'open',
            merged: false,
            user: { login: 'sandy[bot]' },
            head: {
              sha: 'promotion-sha',
              repo: { owner: { login: 'acme' }, name: 'widget' },
            },
            base: { ref: 'main' },
          });
        }
        return jsonResponse({ message: `unexpected ${request}` }, 500);
      },
    });

    await expect(
      client.openProductRulesPullRequest({
        repo: { owner: 'acme', name: 'widget', defaultBranch: 'main' },
        suggestedRuleId: 'suggestedRules:2',
        ruleLine: '- Cache keys must include tenant scope.',
      }),
    ).resolves.toMatchObject({
      number: 45,
      headSha: 'promotion-sha',
      title: 'Add product rule from SuggestedRule suggestedRules:2',
    });

    expect(requests.map((entry) => entry.request)).toContain(
      'POST https://api.github.com/repos/acme/widget/git/refs',
    );
    expect(requests.map((entry) => entry.request)).toContain(
      'PUT https://api.github.com/repos/acme/widget/contents/.bot/product-rules.md',
    );
    const write = requests.find((entry) =>
      entry.request.endsWith('/repos/acme/widget/contents/.bot/product-rules.md'),
    );
    expect(write?.body).toMatchObject({
      branch: 'sandy/suggested-rule-suggestedRules-2',
      sha: 'rules-sha',
    });
    expect(
      Buffer.from(String((write?.body as { content?: unknown })?.content), 'base64').toString(),
    ).toBe('- Existing product rule.\n- Cache keys must include tenant scope.\n');
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

  it('lists close-time capture comments and PR review comment reactions', async () => {
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
          return jsonResponse([
            {
              id: 101,
              body: '<!-- bot:finding=finding-1 -->',
              created_at: '2026-06-01T10:00:00Z',
            },
          ]);
        }
        if (String(url).endsWith('/repos/acme/widget/issues/12/comments?per_page=100&page=1')) {
          return jsonResponse([{ id: 202, body: '<!-- bot:finding=finding-2 -->' }]);
        }
        return jsonResponse([{ content: '-1' }, { content: 'laugh' }]);
      },
    });

    await expect(
      client.listReactionCaptureComments({
        repo: { owner: 'acme', name: 'widget' },
        pullNumber: 12,
      }),
    ).resolves.toEqual([
      {
        id: 101,
        body: '<!-- bot:finding=finding-1 -->',
        kind: 'pull_request_review_comment',
        createdAt: Date.parse('2026-06-01T10:00:00Z'),
      },
      { id: 202, body: '<!-- bot:finding=finding-2 -->', kind: 'issue_comment' },
    ]);
    await expect(
      client.listCommentReactions({
        repo: { owner: 'acme', name: 'widget' },
        commentId: 101,
        commentKind: 'pull_request_review_comment',
      }),
    ).resolves.toEqual([{ content: '-1' }, { content: 'laugh' }]);
    expect(requests).toContain(
      'GET https://api.github.com/repos/acme/widget/issues/12/comments?per_page=100&page=1',
    );
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

  it('lists PR commits and per-commit file patches for merge-state inference', async () => {
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
        if (String(url).endsWith('/repos/acme/widget/pulls/12/commits?per_page=100&page=1')) {
          return jsonResponse([
            {
              sha: 'abc123',
              commit: { committer: { date: '2026-06-01T10:01:00Z' } },
            },
          ]);
        }
        if (String(url).endsWith('/repos/acme/widget/commits/abc123')) {
          return jsonResponse({
            files: [
              {
                filename: 'src/cache.ts',
                previous_filename: 'src/old-cache.ts',
                patch: '@@ -20,1 +20,1 @@\n-old\n+new',
              },
            ],
          });
        }
        return jsonResponse([]);
      },
    });

    await expect(
      client.listPullRequestCommits({
        repo: { owner: 'acme', name: 'widget' },
        pullNumber: 12,
      }),
    ).resolves.toEqual([{ sha: 'abc123', committedAt: Date.parse('2026-06-01T10:01:00Z') }]);
    await expect(
      client.listCommitFiles({
        repo: { owner: 'acme', name: 'widget' },
        commitSha: 'abc123',
      }),
    ).resolves.toEqual([
      {
        filename: 'src/cache.ts',
        previousFilename: 'src/old-cache.ts',
        patch: '@@ -20,1 +20,1 @@\n-old\n+new',
      },
    ]);
    expect(requests).toContain(
      'GET https://api.github.com/repos/acme/widget/pulls/12/commits?per_page=100&page=1',
    );
    expect(requests).toContain('GET https://api.github.com/repos/acme/widget/commits/abc123');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
