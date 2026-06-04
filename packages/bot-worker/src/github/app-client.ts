import { createSign } from 'node:crypto';
import { isIgnoredPath } from '../config/ignore.js';
import type {
  MergeStateCommit,
  MergeStateCommitFile,
  MergeStateGitHub,
} from '../learning/merge-state-inferrer.js';
import type {
  CommentReaction,
  ReactionCaptureComment,
  ReactionCaptureCommentKind,
  ReactionCaptureGitHub,
} from '../learning/reaction-capture.js';
import type { PullRequestFacts, RepoRef } from '../webhook/events.js';
import type { PullRequestResolver } from '../webhook/parse.js';
import type {
  GitHubReviewPoster,
  IssueCommentInput,
  PullRequestTarget,
  ReviewCommentInput,
} from '../worker/poster.js';
import type {
  CompleteReviewStatusCheckInput,
  CreateReviewStatusCheckInput,
  RepoForWorktree,
  ReviewDiffInspector,
  ReviewStatusCheckReporter,
} from '../worker/review-executor.js';

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
const REQUEST_TIMEOUT_MS = 30_000;
const PRODUCT_RULES_PATH = '.bot/product-rules.md';

export class GitHubAppClient
  implements
    GitHubReviewPoster,
    ReviewDiffInspector,
    ReviewStatusCheckReporter,
    PullRequestResolver,
    ReactionCaptureGitHub,
    MergeStateGitHub
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

  async changedLineCount(
    target: PullRequestTarget,
    ignorePatterns: readonly string[] = [],
  ): Promise<number> {
    const files = await this.#listPaginated<unknown>(
      target.owner,
      target.repo,
      `/repos/${target.owner}/${target.repo}/pulls/${target.pullNumber}/files`,
    );
    let total = 0;
    for (const file of files) {
      if (typeof file === 'object' && file !== null) {
        const filename = (file as { filename?: unknown }).filename;
        if (typeof filename === 'string' && isIgnoredPath(filename, ignorePatterns)) {
          continue;
        }
        const additions = Number((file as { additions?: unknown }).additions ?? 0);
        const deletions = Number((file as { deletions?: unknown }).deletions ?? 0);
        total += additions + deletions;
      }
    }
    return total;
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

  async createIssueComment(input: IssueCommentInput): Promise<{ id: number; url?: string }> {
    const raw = await this.#installationRequest<unknown>(
      input.owner,
      input.repo,
      `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
      { method: 'POST', body: { body: input.body } },
    );
    return parseIssueComment(raw);
  }

  async createInProgress(input: CreateReviewStatusCheckInput): Promise<{ id: number }> {
    const raw = await this.#installationRequest<unknown>(
      input.owner,
      input.repo,
      `/repos/${input.owner}/${input.repo}/check-runs`,
      {
        method: 'POST',
        body: {
          name: 'Sandy',
          head_sha: input.headSha,
          status: 'in_progress',
          details_url: input.pullRequestUrl,
          started_at: new Date(input.startedAt).toISOString(),
          output: {
            title: 'Sandy review',
            summary: 'Sandy review is running.',
          },
        },
      },
    );
    return { id: parseCheckRunId(raw) };
  }

  async complete(input: CompleteReviewStatusCheckInput): Promise<void> {
    await this.#installationRequest<unknown>(
      input.owner,
      input.repo,
      `/repos/${input.owner}/${input.repo}/check-runs/${input.checkRunId}`,
      {
        method: 'PATCH',
        body: {
          name: 'Sandy',
          status: 'completed',
          conclusion: input.conclusion,
          details_url: input.detailsUrl,
          completed_at: new Date(input.completedAt).toISOString(),
          output: {
            title: 'Sandy review',
            summary: checkRunSummary(input),
          },
        },
      },
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

  async resolvePullRequestForPush(
    repo: RepoRef,
    branch: string,
    headSha: string,
  ): Promise<PullRequestFacts | null> {
    const head = encodeURIComponent(`${repo.owner}:${branch}`);
    const pulls = await this.#installationRequest<unknown[]>(
      repo.owner,
      repo.name,
      `/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${head}`,
    );

    for (const raw of pulls) {
      const pr = parsePullRequestFacts(raw);
      if (pr?.headSha === headSha) {
        return pr;
      }
    }
    return null;
  }

  async listReactionCaptureComments(input: {
    repo: RepoRef;
    pullNumber: number;
  }): Promise<ReactionCaptureComment[]> {
    const [reviewComments, issueComments] = await Promise.all([
      this.#listReactionCaptureComments(
        input.repo,
        `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.pullNumber}/comments`,
        'pull_request_review_comment',
      ),
      this.#listReactionCaptureComments(
        input.repo,
        `/repos/${input.repo.owner}/${input.repo.name}/issues/${input.pullNumber}/comments`,
        'issue_comment',
      ),
    ]);
    return [...reviewComments, ...issueComments];
  }

  async listCommentReactions(input: {
    repo: RepoRef;
    commentId: number;
    commentKind?: ReactionCaptureCommentKind;
  }): Promise<CommentReaction[]> {
    if (input.commentKind !== undefined) {
      return await this.#listReactionsByKind(input.repo, input.commentId, input.commentKind);
    }

    try {
      return await this.#listReactionsByKind(
        input.repo,
        input.commentId,
        'pull_request_review_comment',
      );
    } catch (error) {
      if (!isGitHubNotFound(error)) {
        throw error;
      }
      return await this.#listReactionsByKind(input.repo, input.commentId, 'issue_comment');
    }
  }

  async listPullRequestCommits(input: {
    repo: RepoRef;
    pullNumber: number;
  }): Promise<MergeStateCommit[]> {
    const raw = await this.#listPaginated<unknown>(
      input.repo.owner,
      input.repo.name,
      `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.pullNumber}/commits`,
    );
    return raw.map(parsePullRequestCommit).filter(isDefined);
  }

  async listCommitFiles(input: {
    repo: RepoRef;
    commitSha: string;
  }): Promise<MergeStateCommitFile[]> {
    const raw = await this.#installationRequest<unknown>(
      input.repo.owner,
      input.repo.name,
      `/repos/${input.repo.owner}/${input.repo.name}/commits/${input.commitSha}`,
    );
    return parseCommitFiles(raw);
  }

  async cloneUrlForRepo(repo: RepoForWorktree): Promise<string> {
    const token = await this.#installationToken(repo.owner, repo.name);
    return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo.owner}/${repo.name}.git`;
  }

  async openProductRulesPullRequest(input: {
    repo: {
      owner: string;
      name: string;
      defaultBranch: string;
    };
    suggestedRuleId: string;
    ruleLine: string;
  }): Promise<PullRequestFacts> {
    const branchName = productRuleBranchName(input.suggestedRuleId);
    const baseSha = await this.#getBranchHeadSha(input.repo, input.repo.defaultBranch);
    await this.#createBranchIfMissing(input.repo, branchName, baseSha);

    const existingFile = await this.#readTextFile(input.repo, PRODUCT_RULES_PATH, branchName);
    const content = appendProductRuleLine(existingFile?.content ?? '', input.ruleLine);
    const writeInput: {
      path: string;
      branchName: string;
      content: string;
      message: string;
      sha?: string;
    } = {
      path: PRODUCT_RULES_PATH,
      branchName,
      content,
      message: `Add product rule from SuggestedRule ${input.suggestedRuleId}`,
    };
    if (existingFile !== null) {
      writeInput.sha = existingFile.sha;
    }
    const headSha = await this.#writeTextFile(input.repo, writeInput);

    const existingPullRequest = await this.resolvePullRequestForPush(
      { owner: input.repo.owner, name: input.repo.name },
      branchName,
      headSha,
    );
    if (existingPullRequest !== null) {
      return existingPullRequest;
    }

    const raw = await this.#installationRequest<unknown>(
      input.repo.owner,
      input.repo.name,
      `/repos/${input.repo.owner}/${input.repo.name}/pulls`,
      {
        method: 'POST',
        body: {
          title: `Add product rule from SuggestedRule ${input.suggestedRuleId}`,
          head: branchName,
          base: input.repo.defaultBranch,
          body: productRulePullRequestBody(input.suggestedRuleId, input.ruleLine),
          draft: false,
        },
      },
    );
    const pullRequest = parsePullRequestFacts(raw);
    if (pullRequest === null) {
      throw new Error('GitHub did not return a valid product-rules pull request');
    }
    return pullRequest;
  }

  async #listReactions(repo: RepoRef, path: string): Promise<CommentReaction[]> {
    const raw = await this.#listPaginated<unknown>(repo.owner, repo.name, path);
    return raw.map(parseCommentReaction).filter(isDefined);
  }

  async #getBranchHeadSha(
    repo: { owner: string; name: string },
    branchName: string,
  ): Promise<string> {
    const raw = await this.#installationRequest<unknown>(
      repo.owner,
      repo.name,
      `/repos/${repo.owner}/${repo.name}/git/ref/heads/${branchName}`,
    );
    return parseGitRefSha(raw);
  }

  async #createBranchIfMissing(
    repo: { owner: string; name: string },
    branchName: string,
    baseSha: string,
  ): Promise<void> {
    try {
      await this.#installationRequest<unknown>(
        repo.owner,
        repo.name,
        `/repos/${repo.owner}/${repo.name}/git/refs`,
        {
          method: 'POST',
          body: { ref: `refs/heads/${branchName}`, sha: baseSha },
        },
      );
    } catch (error) {
      if (isGitHubStatus(error, 422)) {
        return;
      }
      throw error;
    }
  }

  async #readTextFile(
    repo: { owner: string; name: string },
    path: string,
    branchName: string,
  ): Promise<{ sha: string; content: string } | null> {
    try {
      const raw = await this.#installationRequest<unknown>(
        repo.owner,
        repo.name,
        `/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${encodeURIComponent(branchName)}`,
      );
      return parseRepositoryTextFile(raw);
    } catch (error) {
      if (isGitHubNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async #writeTextFile(
    repo: { owner: string; name: string },
    input: {
      path: string;
      branchName: string;
      content: string;
      message: string;
      sha?: string;
    },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      message: input.message,
      content: Buffer.from(input.content, 'utf8').toString('base64'),
      branch: input.branchName,
    };
    if (input.sha !== undefined) {
      body.sha = input.sha;
    }
    const raw = await this.#installationRequest<unknown>(
      repo.owner,
      repo.name,
      `/repos/${repo.owner}/${repo.name}/contents/${input.path}`,
      { method: 'PUT', body },
    );
    return parseContentCommitSha(raw);
  }

  async #listReactionsByKind(
    repo: RepoRef,
    commentId: number,
    commentKind: ReactionCaptureCommentKind,
  ): Promise<CommentReaction[]> {
    return await this.#listReactions(repo, commentReactionsPath(repo, commentId, commentKind));
  }

  async #listReactionCaptureComments(
    repo: RepoRef,
    path: string,
    commentKind: ReactionCaptureCommentKind,
  ): Promise<ReactionCaptureComment[]> {
    const raw = await this.#listPaginated<unknown>(repo.owner, repo.name, path);
    return raw
      .map((comment) => parseReactionCaptureComment(comment, commentKind))
      .filter(isDefined);
  }

  async #listPaginated<T>(owner: string, repo: string, path: string): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    while (true) {
      const separator = path.includes('?') ? '&' : '?';
      const pageItems = await this.#installationRequest<T[]>(
        owner,
        repo,
        `${path}${separator}per_page=100&page=${page}`,
      );
      all.push(...pageItems);
      if (pageItems.length < 100) {
        return all;
      }
      page += 1;
    }
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      throw new GitHubApiError(
        `GitHub API ${options.method ?? 'GET'} ${path} failed (${response.status}): ${text}`,
        response.status,
      );
    }
    return (text.length === 0 ? null : JSON.parse(text)) as T;
  }
}

class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function isGitHubNotFound(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 404;
}

function isGitHubStatus(error: unknown, status: number): boolean {
  return error instanceof GitHubApiError && error.status === status;
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
    state: parsePullRequestState(object),
    headRepo: parseRepoRef(object.head?.repo),
  };
}

function parsePullRequestState(raw: {
  merged?: unknown;
  state?: unknown;
}): PullRequestFacts['state'] {
  if (raw.merged === true) {
    return 'merged';
  }
  if (raw.state === 'closed') {
    return 'closed';
  }
  return 'open';
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

function parseGitRefSha(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('GitHub ref response was not an object');
  }
  const sha = (raw as { object?: { sha?: unknown } }).object?.sha;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error('GitHub ref response did not include object.sha');
  }
  return sha;
}

function parseRepositoryTextFile(raw: unknown): { sha: string; content: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('GitHub contents response was not a file object');
  }
  const file = raw as {
    type?: unknown;
    sha?: unknown;
    encoding?: unknown;
    content?: unknown;
  };
  if (
    file.type !== 'file' ||
    typeof file.sha !== 'string' ||
    file.encoding !== 'base64' ||
    typeof file.content !== 'string'
  ) {
    throw new Error('GitHub contents response did not include a base64 file');
  }
  return {
    sha: file.sha,
    content: Buffer.from(file.content.replaceAll(/\s/g, ''), 'base64').toString('utf8'),
  };
}

function parseContentCommitSha(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('GitHub contents update response was not an object');
  }
  const sha = (raw as { commit?: { sha?: unknown } }).commit?.sha;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error('GitHub contents update response did not include commit.sha');
  }
  return sha;
}

function parseIssueComment(raw: unknown): { id: number; url?: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('GitHub issue comment response was not an object');
  }
  const object = raw as { id?: unknown; html_url?: unknown };
  if (typeof object.id !== 'number') {
    throw new Error('GitHub issue comment response did not include id');
  }
  if (typeof object.html_url === 'string') {
    return { id: object.id, url: object.html_url };
  }
  return { id: object.id };
}

function parseCheckRunId(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('GitHub Check Run response was not an object');
  }
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== 'number') {
    throw new Error('GitHub Check Run response did not include id');
  }
  return id;
}

function checkRunSummary(input: CompleteReviewStatusCheckInput): string {
  if (input.summaryCommentUrl === undefined) {
    return `${input.verdict}.`;
  }
  return `${input.verdict}. [View summary](${input.summaryCommentUrl}).`;
}

function productRuleBranchName(suggestedRuleId: string): string {
  const slug = suggestedRuleId
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return `sandy/suggested-rule-${slug.length === 0 ? 'rule' : slug}`;
}

function appendProductRuleLine(content: string, ruleLine: string): string {
  const normalizedContent = content.replace(/\r\n/g, '\n').trimEnd();
  const normalizedRule = ruleLine.trim();
  if (normalizedContent.length === 0) {
    return `${normalizedRule}\n`;
  }
  return `${normalizedContent}\n${normalizedRule}\n`;
}

function productRulePullRequestBody(suggestedRuleId: string, ruleLine: string): string {
  return [
    `Promotes SuggestedRule \`${suggestedRuleId}\` into \`${PRODUCT_RULES_PATH}\`.`,
    '',
    'Rule:',
    '',
    ruleLine,
    '',
    'Sandy opts this PR into review so the drafted rule is checked before merge.',
  ].join('\n');
}

function commentReactionsPath(
  repo: RepoRef,
  commentId: number,
  commentKind: ReactionCaptureCommentKind,
): string {
  switch (commentKind) {
    case 'pull_request_review_comment':
      return `/repos/${repo.owner}/${repo.name}/pulls/comments/${commentId}/reactions`;
    case 'issue_comment':
      return `/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}/reactions`;
  }
}

function parseReactionCaptureComment(
  raw: unknown,
  kind: ReactionCaptureCommentKind,
): ReactionCaptureComment | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const object = raw as { id?: unknown; body?: unknown; created_at?: unknown };
  if (typeof object.id !== 'number' || typeof object.body !== 'string') {
    return undefined;
  }
  const createdAt = parseTimestamp(object.created_at);
  return createdAt === undefined
    ? { id: object.id, body: object.body, kind }
    : { id: object.id, body: object.body, kind, createdAt };
}

function parseCommentReaction(raw: unknown): CommentReaction | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const content = (raw as { content?: unknown }).content;
  return typeof content === 'string' ? { content } : undefined;
}

function parsePullRequestCommit(raw: unknown): MergeStateCommit | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const object = raw as {
    sha?: unknown;
    commit?: { committer?: { date?: unknown }; author?: { date?: unknown } };
  };
  if (typeof object.sha !== 'string') {
    return undefined;
  }
  const committedAt =
    parseTimestamp(object.commit?.committer?.date) ?? parseTimestamp(object.commit?.author?.date);
  return committedAt === undefined ? undefined : { sha: object.sha, committedAt };
}

function parseCommitFiles(raw: unknown): MergeStateCommitFile[] {
  if (typeof raw !== 'object' || raw === null) {
    return [];
  }
  const files = (raw as { files?: unknown }).files;
  return Array.isArray(files) ? files.map(parseCommitFile).filter(isDefined) : [];
}

function parseCommitFile(raw: unknown): MergeStateCommitFile | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const object = raw as { filename?: unknown; previous_filename?: unknown; patch?: unknown };
  if (typeof object.filename !== 'string') {
    return undefined;
  }
  const file: MergeStateCommitFile = { filename: object.filename };
  if (typeof object.previous_filename === 'string') {
    file.previousFilename = object.previous_filename;
  }
  if (typeof object.patch === 'string') {
    file.patch = object.patch;
  }
  return file;
}

function parseTimestamp(raw: unknown): number | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
