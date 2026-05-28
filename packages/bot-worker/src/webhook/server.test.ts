import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRef } from './events.js';
import { startWebhookServer } from './server.js';
import type { EnqueueInput, ReviewSink, UpsertPullRequestInput } from './sink.js';

const SECRET = 'server-test-secret';

class RecordingSink implements ReviewSink {
  reviewActive = false;
  readonly enqueued: EnqueueInput[] = [];
  readonly upserts: UpsertPullRequestInput[] = [];

  async ensureRepo(repo: RepoRef): Promise<string> {
    return `repo:${repo.owner}/${repo.name}`;
  }
  async getReviewActive(): Promise<boolean> {
    return this.reviewActive;
  }
  async upsertPullRequest(input: UpsertPullRequestInput): Promise<string> {
    this.upserts.push(input);
    return `pr:${input.number}`;
  }
  async setReviewActive(): Promise<void> {}
  async clearOnClose(): Promise<void> {}
  async enqueueReviewJob(input: EnqueueInput): Promise<string> {
    this.enqueued.push(input);
    return 'job:1';
  }
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

const logger = { info: vi.fn(), warn: vi.fn() };

let server: Awaited<ReturnType<typeof startWebhookServer>>;
let sink: RecordingSink;
let baseUrl: string;

async function post(
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}/webhook`, { method: 'POST', body, headers });
  return { status: res.status, text: await res.text() };
}

beforeEach(async () => {
  sink = new RecordingSink();
  server = await startWebhookServer(0, { webhookSecret: SECRET, sink, logger });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('webhook server', () => {
  const mentionBody = JSON.stringify({
    action: 'created',
    repository: { owner: { login: 'tony-co' }, name: 'sandy' },
    comment: { body: '@bot review' },
    pull_request: {
      number: 7,
      title: 'PR',
      html_url: 'https://example.test/pr/7',
      user: { login: 'octocat' },
      head: { sha: 'sha-7', repo: { owner: { login: 'tony-co' }, name: 'sandy' } },
      base: { ref: 'main' },
    },
  });

  it('rejects a request with a missing signature (401) and does not dispatch', async () => {
    const res = await post(mentionBody, { 'x-github-event': 'pull_request_review_comment' });
    expect(res.status).toBe(401);
    expect(sink.enqueued).toHaveLength(0);
  });

  it('rejects a request with a bad signature (401)', async () => {
    const res = await post(mentionBody, {
      'x-github-event': 'pull_request_review_comment',
      'x-hub-signature-256': 'sha256=deadbeef',
    });
    expect(res.status).toBe(401);
    expect(sink.enqueued).toHaveLength(0);
  });

  it('rejects a signature computed with the wrong secret (401)', async () => {
    const wrong = `sha256=${createHmac('sha256', 'nope').update(mentionBody).digest('hex')}`;
    const res = await post(mentionBody, {
      'x-github-event': 'pull_request_review_comment',
      'x-hub-signature-256': wrong,
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid signature and dispatches the @bot review mention', async () => {
    const res = await post(mentionBody, {
      'x-github-event': 'pull_request_review_comment',
      'x-hub-signature-256': sign(mentionBody),
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('enqueued');
    expect(sink.enqueued).toHaveLength(1);
    expect(sink.enqueued[0]).toMatchObject({ trigger: 'mention', agentKeys: ['logic'] });
  });

  it('acknowledges a verified but unsupported event without dispatching (202)', async () => {
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const res = await post(body, {
      'x-github-event': 'ping',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(202);
    expect(sink.enqueued).toHaveLength(0);
  });

  it('returns 404 for a non-webhook path', async () => {
    const res = await fetch(`${baseUrl}/other`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('returns 405 for a non-POST method', async () => {
    const res = await fetch(`${baseUrl}/webhook`, { method: 'GET' });
    expect(res.status).toBe(405);
  });
});
