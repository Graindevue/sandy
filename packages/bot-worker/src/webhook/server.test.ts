import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRef } from './events.js';
import { createWebhookHandler, startWebhookServer } from './server.js';
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
  const res = await fetch(`${baseUrl}/`, { method: 'POST', body, headers });
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

  it('returns 404 for a non-matching path', async () => {
    const res = await fetch(`${baseUrl}/other`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('returns 405 for a non-POST method', async () => {
    const res = await fetch(`${baseUrl}/`, { method: 'GET' });
    expect(res.status).toBe(405);
  });
});

describe('webhook body size guard (#7)', () => {
  // Finding #7: the over-size branch used to reject AND `req.destroy()` the shared
  // socket synchronously, so the later 413 wrote to a dead socket and the client
  // saw a connection reset instead. With a small maxBodyBytes an over-size POST
  // must still receive an actual 413 response.
  let smallServer: Awaited<ReturnType<typeof startWebhookServer>>;
  let smallUrl: string;

  beforeEach(async () => {
    smallServer = await startWebhookServer(0, {
      webhookSecret: SECRET,
      sink: new RecordingSink(),
      logger,
      maxBodyBytes: 16,
    });
    const { port } = smallServer.address() as AddressInfo;
    smallUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => smallServer.close(() => resolve()));
  });

  it('responds 413 (not a connection reset) to an over-size body', async () => {
    const res = await fetch(`${smallUrl}/`, {
      method: 'POST',
      body: 'x'.repeat(64),
      headers: { 'x-github-event': 'pull_request' },
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('payload too large');
  });
});

describe('webhook body read error (#5)', () => {
  // Finding #5: every readRawBody rejection used to map to 413. A 413 is permanent
  // to GitHub (no redelivery), so a transient transport error (client disconnect /
  // ECONNRESET mid-body, surfaced as `req` emitting 'error') must map to 500 — only
  // the size guard is a 413.
  function fakeRes(): ServerResponse & { statusCode?: number } {
    const res = {
      headersSent: false,
      writeHead(status: number) {
        res.statusCode = status;
        res.headersSent = true;
        return res;
      },
      end() {
        return res;
      },
    } as unknown as ServerResponse & { statusCode?: number };
    return res;
  }

  it('maps a mid-body transport error to 500, not 413', async () => {
    const handler = createWebhookHandler({ webhookSecret: SECRET, sink: new RecordingSink() });
    const req = new EventEmitter() as IncomingMessage;
    req.url = '/';
    req.method = 'POST';
    req.headers = {};
    const res = fakeRes();

    const done = handler(req, res);
    // A chunk arrives, then the transport fails before 'end'.
    req.emit('data', Buffer.from('{}'));
    req.emit('error', new Error('ECONNRESET'));
    await done;

    expect(res.statusCode).toBe(500);
  });
});
