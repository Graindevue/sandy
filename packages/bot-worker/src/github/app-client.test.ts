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
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
