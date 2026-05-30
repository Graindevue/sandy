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

interface PushFacts {
  repo: RepoRef;
  branch: string;
  headSha: string;
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
function parsePullRequestFacts(raw: RawPullRequest | null | undefined): PullRequestFacts | null {
  if (raw == null) {
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
  // or `edited` comment can still carry the original body, so without this guard
  // deletion/edit events could start or re-fire a review.
  if (payload.action !== 'created') {
    const event = isReviewComment ? 'pull_request_review_comment' : 'issue_comment';
    return ignored(`${event}: action ${payload.action ?? 'missing'} is not created`);
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
    // The dispatch path uses parseEventForDispatch() to resolve those through
    // the GitHub API; the pure parser fails closed when called without one.
    return ignored('comment: pull_request details unavailable');
  }
  return { kind: 'comment', repo, body, pr } satisfies CommentEvent;
}

export interface PullRequestResolver {
  resolvePullRequest(repo: RepoRef, number: number): Promise<PullRequestFacts | null>;
  resolvePullRequestForPush?(
    repo: RepoRef,
    branch: string,
    headSha: string,
  ): Promise<PullRequestFacts | null>;
}

async function parseResolvableIssueCommentEvent(
  payload: RawCommentPayload,
  resolver: PullRequestResolver,
): Promise<ParsedEvent> {
  if (payload.issue?.pull_request === undefined) {
    return ignored('issue_comment: not on a pull request');
  }
  if (payload.action !== 'created') {
    return ignored(`issue_comment: action ${payload.action ?? 'missing'} is not created`);
  }
  const repo = parseRepoRef(payload.repository);
  if (repo === null) {
    return ignored('comment: missing repository');
  }
  const body = payload.comment?.body;
  if (typeof body !== 'string') {
    return ignored('comment: missing body');
  }
  const number = payload.issue.number;
  if (typeof number !== 'number') {
    return ignored('issue_comment: missing issue number');
  }
  let pr: PullRequestFacts | null;
  try {
    pr = await resolver.resolvePullRequest(repo, number);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return ignored(`issue_comment: pull_request resolution failed: ${detail}`);
  }
  if (pr === null) {
    return ignored('issue_comment: pull_request details unavailable');
  }
  return { kind: 'comment', repo, body, pr } satisfies CommentEvent;
}

async function parseResolvablePushEvent(
  payload: RawPushPayload,
  resolver: PullRequestResolver,
): Promise<ParsedEvent> {
  const facts = parsePushFacts(payload);
  if ('reason' in facts) {
    return ignored(facts.reason);
  }
  if (resolver.resolvePullRequestForPush === undefined) {
    return ignored('push: pull_request details unavailable');
  }

  let pr: PullRequestFacts | null;
  try {
    // Call as a method (not a detached local) so `this` binds — the real
    // GitHubAppClient resolver reads `this.#…`, which throws when unbound.
    pr = await resolver.resolvePullRequestForPush(facts.repo, facts.branch, facts.headSha);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return ignored(`push: pull_request resolution failed: ${detail}`);
  }
  if (pr === null) {
    return ignored('push: no open pull request for head');
  }
  return { kind: 'push', repo: facts.repo, pr } satisfies PushEvent;
}

function parsePushEvent(payload: RawPushPayload): ParsedEvent {
  const facts = parsePushFacts(payload);
  if ('reason' in facts) {
    return ignored(facts.reason);
  }
  // A push payload names a branch, not a PR. parseEventForDispatch() resolves
  // this through GitHub before dispatch; the pure parser fails closed without
  // that network dependency.
  return ignored('push: pull_request details unavailable');
}

function parsePushFacts(payload: RawPushPayload): PushFacts | { reason: string } {
  if (payload.deleted === true) {
    return { reason: 'push: branch deleted' };
  }
  const repo = parseRepoRef(payload.repository);
  if (repo === null) {
    return { reason: 'push: missing repository' };
  }
  const headSha = payload.after;
  const ref = payload.ref;
  if (typeof headSha !== 'string' || typeof ref !== 'string') {
    return { reason: 'push: missing after/ref' };
  }
  const prefix = 'refs/heads/';
  if (!ref.startsWith(prefix) || ref.length === prefix.length) {
    return { reason: 'push: ref is not a branch' };
  }
  return { repo, branch: ref.slice(prefix.length), headSha };
}

/**
 * Normalize a raw GitHub webhook payload into a {@link ParsedEvent}. Unknown or
 * malformed deliveries fail closed to an `ignored` event so the dispatcher never
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

/**
 * Normalize a delivery for dispatch, using the GitHub API for payloads that are
 * valid review signals but do not embed full PR facts. PR Conversation comments
 * (`issue_comment`) carry only an issue number, and `push` deliveries carry a
 * branch ref rather than a PR, so Sandy resolves the PR before Sticky Opt-In
 * evaluation.
 */
export async function parseEventForDispatch(
  eventName: SupportedEventName,
  payload: unknown,
  resolver?: PullRequestResolver,
): Promise<ParsedEvent> {
  if (resolver !== undefined && isResolvableIssueCommentPayload(eventName, payload)) {
    return await parseResolvableIssueCommentEvent(payload, resolver);
  }
  if (resolver !== undefined && isResolvablePushPayload(eventName, payload)) {
    return await parseResolvablePushEvent(payload, resolver);
  }
  return parseEvent(eventName, payload);
}

function isResolvableIssueCommentPayload(
  eventName: SupportedEventName,
  payload: unknown,
): payload is RawCommentPayload {
  return (
    eventName === 'issue_comment' &&
    typeof payload === 'object' &&
    payload !== null &&
    (payload as RawCommentPayload).pull_request == null
  );
}

function isResolvablePushPayload(
  eventName: SupportedEventName,
  payload: unknown,
): payload is RawPushPayload {
  return eventName === 'push' && typeof payload === 'object' && payload !== null;
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
