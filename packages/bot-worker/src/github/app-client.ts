import { createSign } from 'node:crypto';
import type { PullRequestFacts, RepoRef } from '../webhook/events.js';
import type { PullRequestResolver } from '../webhook/parse.js';
import type {
  GitHubReviewPoster,
  IssueCommentInput,
  PullRequestTarget,
  ReviewCommentInput,
} from '../worker/poster.js';
import type { RepoForWorktree, ReviewDiffInspector } from '../worker/review-executor.js';

type Fetch = typeof fetch;

export interface GitHubAppClientOptions {
  appId: string;
  privateKey: string;
  fetch?: Fetch;
  now?: () => number;
  createJwt?: () => string;
}

interface InstallationToken {
  token: string;
  expiresAt: number;
}

const GITHUB_API_BASE = 'https://api.github.com';
const TOKEN_REFRESH_SKEW_MS = 60_000;

export class GitHubAppClient
  implements GitHubReviewPoster, ReviewDiffInspector, PullRequestResolver
{
  readonly #appId: string;
  readonly #privateKey: string;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #createJwt: () => string;
  readonly #tokens = new Map<string, InstallationToken>();

  constructor(options: GitHubAppClientOptions) {
    this.#appId = options.appId;
    this.#privateKey = normalizePrivateKey(options.privateKey);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#createJwt =
      options.createJwt ??
      (() =>
        createGitHubAppJwt({
          appId: this.#appId,
          privateKey: this.#privateKey,
          now: this.#now,
        }));
  }

  async changedLineCount(target: PullRequestTarget): Promise<number> {
    let total = 0;
    let page = 1;
    while (true) {
      const files = await this.#installationRequest<unknown[]>(
        target.owner,
        target.repo,
        `/repos/${target.owner}/${target.repo}/pulls/${target.pullNumber}/files?per_page=100&page=${page}`,
      );
      for (const file of files) {
        if (typeof file === 'object' && file !== null) {
          const additions = Number((file as { additions?: unknown }).additions ?? 0);
          const deletions = Number((file as { deletions?: unknown }).deletions ?? 0);
          total += additions + deletions;
        }
      }
      if (files.length < 100) {
        return total;
      }
      page += 1;
    }
  }

  async createPullRequestReviewComment(input: ReviewCommentInput): Promise<{ id: number }> {
    const body: Record<string, unknown> = {
      body: input.body,
      commit_id: input.commitId,
      path: input.path,
      line: input.line,
      side: input.side,
    };
    if (input.startLine !== undefined) {
      body.start_line = input.startLine;
      body.start_side = input.startSide;
    }
    return await this.#installationRequest<{ id: number }>(
      input.owner,
      input.repo,
      `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/comments`,
      { method: 'POST', body },
    );
  }

  async createIssueComment(input: IssueCommentInput): Promise<{ id: number }> {
    return await this.#installationRequest<{ id: number }>(
      input.owner,
      input.repo,
      `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
      { method: 'POST', body: { body: input.body } },
    );
  }

  async resolvePullRequest(repo: RepoRef, number: number): Promise<PullRequestFacts | null> {
    const raw = await this.#installationRequest<unknown>(
      repo.owner,
      repo.name,
      `/repos/${repo.owner}/${repo.name}/pulls/${number}`,
    );
    return parsePullRequestFacts(raw);
  }

  async cloneUrlForRepo(repo: RepoForWorktree): Promise<string> {
    const token = await this.#installationToken(repo.owner, repo.name);
    return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo.owner}/${repo.name}.git`;
  }

  async #installationRequest<T>(
    owner: string,
    repo: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const token = await this.#installationToken(owner, repo);
    const request: { method?: string; token: string; body?: unknown } = { token };
    if (init.method !== undefined) {
      request.method = init.method;
    }
    if (init.body !== undefined) {
      request.body = init.body;
    }
    return await this.#requestJson<T>(path, request);
  }

  async #installationToken(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = this.#tokens.get(key);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > this.#now()) {
      return cached.token;
    }

    const installation = await this.#requestJson<{ id: number }>(
      `/repos/${owner}/${repo}/installation`,
      {
        token: this.#createJwt(),
      },
    );
    const token = await this.#requestJson<{ token: string; expires_at: string }>(
      `/app/installations/${installation.id}/access_tokens`,
      { method: 'POST', token: this.#createJwt() },
    );

    this.#tokens.set(key, {
      token: token.token,
      expiresAt: Date.parse(token.expires_at),
    });
    return token.token;
  }

  async #requestJson<T>(
    path: string,
    options: { method?: string; token: string; body?: unknown },
  ): Promise<T> {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    const response = await this.#fetch(`${GITHUB_API_BASE}${path}`, init);

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub API ${options.method ?? 'GET'} ${path} failed (${response.status}): ${text}`,
      );
    }
    return (text.length === 0 ? null : JSON.parse(text)) as T;
  }
}

function createGitHubAppJwt(options: {
  appId: string;
  privateKey: string;
  now: () => number;
}): string {
  const nowSeconds = Math.floor(options.now() / 1000);
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64urlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: options.appId,
  });
  const input = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(input);
  sign.end();
  return `${input}.${sign.sign(options.privateKey).toString('base64url')}`;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, '\n');
}

function parsePullRequestFacts(raw: unknown): PullRequestFacts | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const object = raw as {
    number?: unknown;
    draft?: unknown;
    title?: unknown;
    html_url?: unknown;
    state?: unknown;
    merged?: unknown;
    user?: { login?: unknown };
    head?: { sha?: unknown; repo?: unknown };
    base?: { ref?: unknown };
  };
  const number = object.number;
  const headSha = object.head?.sha;
  const baseRef = object.base?.ref;
  if (typeof number !== 'number' || typeof headSha !== 'string' || typeof baseRef !== 'string') {
    return null;
  }
  return {
    number,
    draft: object.draft === true,
    headSha,
    baseRef,
    title: typeof object.title === 'string' ? object.title : '',
    author: typeof object.user?.login === 'string' ? object.user.login : '',
    url: typeof object.html_url === 'string' ? object.html_url : '',
    state: object.merged === true ? 'merged' : object.state === 'closed' ? 'closed' : 'open',
    headRepo: parseRepoRef(object.head?.repo),
  };
}

function parseRepoRef(raw: unknown): RepoRef | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const object = raw as { owner?: { login?: unknown }; name?: unknown };
  return typeof object.owner?.login === 'string' && typeof object.name === 'string'
    ? { owner: object.owner.login, name: object.name }
    : null;
}
