import { describe, expect, it } from 'vitest';
import { GitHubAppClient } from './app-client.js';

describe('GitHubAppClient', () => {
  it('counts changed lines across PR files', async () => {
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
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
