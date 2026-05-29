import type { PullRequestState } from '@sandy/shared-types';
import type {
  CommentEvent,
  ParsedEvent,
  PullRequestEvent,
  PullRequestFacts,
  PushEvent,
  RepoRef,
  SupportedEventName,
} from './events.js';

/**
 * The fragments of GitHub's webhook payloads that Sandy reads. These are
 * deliberately partial: GitHub sends far more, and fields can be absent on
 * malformed or unexpected deliveries, so everything optional is treated as
 * possibly missing and parsing fails closed to an `ignored` event.
 */
interface RawRepoRef {
  owner?: { login?: string };
  name?: string;
}

interface RawPullRequest {
  number?: number;
  draft?: boolean;
  title?: string;
  html_url?: string;
  state?: string;
  merged?: boolean;
  user?: { login?: string };
  head?: { sha?: string; repo?: RawRepoRef | null };
  base?: { ref?: string };
}

interface RawPullRequestPayload {
  action?: string;
  repository?: RawRepoRef;
  pull_request?: RawPullRequest;
}

interface RawCommentPayload {
  action?: string;
  repository?: RawRepoRef;
  comment?: { body?: string };
  issue?: { pull_request?: unknown; number?: number };
  pull_request?: RawPullRequest;
}

interface RawPushPayload {
  repository?: RawRepoRef;
  after?: string;
  ref?: string;
  deleted?: boolean;
}

function ignored(reason: string): ParsedEvent {
  return { kind: 'ignored', reason };
}

function parseRepoRef(raw: RawRepoRef | null | undefined): RepoRef | null {
  const owner = raw?.owner?.login;
  const name = raw?.name;
  if (typeof owner !== 'string' || typeof name !== 'string') {
    return null;
  }
  return { owner, name };
}

/**
 * Derive the PR's lifecycle state from GitHub's `state` ('open' | 'closed') and
 * `merged` flag: a merged PR reports `state: 'closed'` plus `merged: true`, so
 * `merged` is checked first. An unrecognized `state` falls back to `'open'` (the
 * GitHub default) so a malformed delivery is not mistaken for a dead PR.
 */
function parsePullRequestState(raw: RawPullRequest): PullRequestState {
  if (raw.merged === true) {
    return 'merged';
  }
  return raw.state === 'closed' ? 'closed' : 'open';
}

/**
 * Build {@link PullRequestFacts}. The head Repo is left `null` when GitHub could
 * not resolve it (missing or `null` `head.repo`, e.g. a deleted fork) rather than
 * being defaulted to the base Repo, so the fork-decline guard is not bypassed.
 */
function parsePullRequestFacts(raw: RawPullRequest | undefined): PullRequestFacts | null {
  if (raw === undefined) {
    return null;
  }
  const { number, head, base } = raw;
  const headSha = head?.sha;
  const baseRef = base?.ref;
  if (typeof number !== 'number' || typeof headSha !== 'string' || typeof baseRef !== 'string') {
    return null;
  }
  return {
    number,
    draft: raw.draft ?? false,
    headSha,
    baseRef,
    title: raw.title ?? '',
    author: raw.user?.login ?? '',
    url: raw.html_url ?? '',
    state: parsePullRequestState(raw),
    headRepo: parseRepoRef(head?.repo),
  };
}

function parsePullRequestEvent(payload: RawPullRequestPayload): ParsedEvent {
  const repo = parseRepoRef(payload.repository);
  if (repo === null) {
    return ignored('pull_request: missing repository');
  }
  const pr = parsePullRequestFacts(payload.pull_request);
  if (pr === null) {
    return ignored('pull_request: missing pull_request fields');
  }
  const action = normalizePullRequestAction(payload.action);
  return { kind: 'pull_request', action, repo, pr } satisfies PullRequestEvent;
}

function normalizePullRequestAction(action: string | undefined): PullRequestEvent['action'] {
  switch (action) {
    case 'opened':
    case 'synchronize':
    case 'ready_for_review':
    case 'closed':
    case 'reopened':
      return action;
    default:
      return 'other';
  }
}

function parseCommentEvent(payload: RawCommentPayload, isReviewComment: boolean): ParsedEvent {
  // An `issue_comment` only relates to a PR when its issue carries a
  // `pull_request` field; plain issue comments are not review signals.
  if (!isReviewComment && payload.issue?.pull_request === undefined) {
    return ignored('issue_comment: not on a pull request');
  }
  // Only a newly *created* comment can be an `@bot review` mention. A `deleted`
  // or `edited` `pull_request_review_comment` still carries the body and the full
  // `pull_request`, so without this guard deleting the opt-in comment would start
  // a review and editing it would re-fire one. (The `issue_comment` path needs no
  // such guard: its payload lacks `pull_request`, so it already parses to
  // `ignored` below.)
  if (isReviewComment && payload.action !== 'created') {
    return ignored(
      `pull_request_review_comment: action ${payload.action ?? 'missing'} is not created`,
    );
  }
  const repo = parseRepoRef(payload.repository);
  if (repo === null) {
    return ignored('comment: missing repository');
  }
  const body = payload.comment?.body;
  if (typeof body !== 'string') {
    return ignored('comment: missing body');
  }
  const pr = parsePullRequestFacts(payload.pull_request);
  if (pr === null) {
    // `issue_comment` payloads carry only `issue`, not the full `pull_request`.
    // Resolving the PR's head SHA / fork status then needs a GitHub API lookup,
    // which lands with the API client in #6. Until then, opt-in via mention is
    // driven through `pull_request_review_comment`, whose payload includes the PR.
    return ignored('comment: pull_request details unavailable (resolve via API in #6)');
  }
  return { kind: 'comment', repo, body, pr } satisfies CommentEvent;
}

function parsePushEvent(payload: RawPushPayload): ParsedEvent {
  if (payload.deleted === true) {
    return ignored('push: branch deleted');
  }
  const repo = parseRepoRef(payload.repository);
  if (repo === null) {
    return ignored('push: missing repository');
  }
  const headSha = payload.after;
  const ref = payload.ref;
  if (typeof headSha !== 'string' || typeof ref !== 'string') {
    return ignored('push: missing after/ref');
  }
  // A push payload names a branch, not a PR. Mapping the branch to its open PR
  // (and the PR's number / base / fork status) requires a GitHub API lookup,
  // which arrives with the API client in #6. The dedicated `pull_request`
  // `synchronize` delivery already covers re-review of opted-in PRs in the
  // meantime, so a bare push is recorded and ignored here.
  return ignored('push: PR resolution deferred to #6 (covered by pull_request synchronize)');
}

/**
 * Normalize a raw GitHub webhook payload into a {@link ParsedEvent}. Unknown or
 * malformed deliveries — and the event kinds whose PR resolution needs a GitHub
 * API lookup (#6) — fail closed to an `ignored` event so the dispatcher never
 * acts on incomplete data.
 */
export function parseEvent(eventName: SupportedEventName, payload: unknown): ParsedEvent {
  if (typeof payload !== 'object' || payload === null) {
    return ignored(`${eventName}: payload is not an object`);
  }
  switch (eventName) {
    case 'pull_request':
      return parsePullRequestEvent(payload as RawPullRequestPayload);
    case 'issue_comment':
      return parseCommentEvent(payload as RawCommentPayload, false);
    case 'pull_request_review_comment':
      return parseCommentEvent(payload as RawCommentPayload, true);
    case 'push':
      return parsePushEvent(payload as RawPushPayload);
  }
}

/** Whether a string is one of the webhook events Sandy subscribes to. */
export function isSupportedEvent(eventName: string | undefined): eventName is SupportedEventName {
  return (
    eventName === 'pull_request' ||
    eventName === 'issue_comment' ||
    eventName === 'pull_request_review_comment' ||
    eventName === 'push'
  );
}

/**
 * The PR `state` Sandy persists for an event. Reflects the PR's real lifecycle
 * state as parsed from the payload (`open` / `closed` / `merged`) rather than
 * assuming `'open'`, so a comment on a closed or merged PR does not clobber the
 * stored state back to `'open'`.
 */
export function prStateForEvent(event: PullRequestEvent | CommentEvent | PushEvent): {
  state: PullRequestState;
} {
  return { state: event.pr.state };
}
