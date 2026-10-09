import { makeFunctionReference } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewServiceClient } from './review-service-client.js';

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL:
    'https://pipelines.actions.githubusercontent.com/idtoken?api-version=2',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'dummy-oidc-request-credential',
};
const url = 'https://test.convex.cloud';
const queryRef = makeFunctionReference<'query'>('reviewJobs:getStatus');
const mutationRef = makeFunctionReference<'mutation'>('reviewJobs:claim');
const actionRef = makeFunctionReference<'action'>('archetypes:assignOrCreateArchetype');

function token(exp: number) {
  return `dummy.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.dummy`;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ReviewServiceClient', () => {
  it('requires a trusted HTTPS Actions OIDC endpoint and explicit job permission', () => {
    expect(() => new ReviewServiceClient(url, {})).toThrow('id-token: write');
    for (const endpoint of [
      'http://pipelines.actions.githubusercontent.com/idtoken',
      'https://attacker.example/idtoken',
      'https://pipelines.actions.githubusercontent.com.attacker.example/idtoken',
      'https://user:password@pipelines.actions.githubusercontent.com/idtoken',
    ]) {
      expect(
        () => new ReviewServiceClient(url, { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: endpoint }),
      ).toThrow('endpoint');
    }
  });

  it('authenticates every function type, shares refresh, and renews an expiring token', async () => {
    const calls: Array<{ input: string; headers: Headers; body: string }> = [];
    let issued = 0;
    const tokens: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const target = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ input: target, headers, body: String(init?.body ?? '') });
        if (target.startsWith(env.ACTIONS_ID_TOKEN_REQUEST_URL)) {
          const value = token(Math.floor(Date.now() / 1000) + 300 + issued++);
          tokens.push(value);
          return new Response(JSON.stringify({ value }));
        }
        return new Response(JSON.stringify({ status: 'success', value: true }));
      }),
    );
    const client = new ReviewServiceClient(url, env);
    await Promise.all([
      client.query(queryRef, {}),
      client.mutation(mutationRef, {}),
      client.action(actionRef, {}),
    ]);
    expect(issued).toBe(1);
    const oidc = calls.find((call) => call.input.includes('idtoken'));
    expect(new URL(oidc?.input ?? '').searchParams.get('audience')).toBe('sandy-review');
    expect(oidc?.headers.get('authorization')).toBe(`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`);
    for (const call of calls.filter((call) => call.input.startsWith(url))) {
      expect(call.headers.get('authorization')).toBe(`Bearer ${tokens[0]}`);
      expect(call.body).not.toContain(tokens[0]);
      expect(call.body).not.toContain(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
    }
    vi.advanceTimersByTime(241_000);
    await client.query(queryRef, {});
    expect(issued).toBe(2);
    expect(calls.at(-1)?.headers.get('authorization')).toBe(`Bearer ${tokens[1]}`);
  });

  it('fails closed without contacting Convex and never exposes provider errors', async () => {
    const fetch = vi.fn(async () => {
      throw new Error(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
    });
    vi.stubGlobal('fetch', fetch);
    const client = new ReviewServiceClient(url, env);
    await expect(client.mutation(mutationRef, {})).rejects.toThrow('Unable to authenticate');
    expect(fetch).toHaveBeenCalledOnce();
    await expect(client.query(queryRef, {})).rejects.not.toThrow(
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    );
  });

  it('does not expose a credential reflected in a backend error', async () => {
    const value = token(Math.floor(Date.now() / 1000) + 300);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) =>
        String(input).includes('idtoken')
          ? new Response(JSON.stringify({ value }))
          : new Response(JSON.stringify({ status: 'error', errorMessage: `Reflected ${value}` })),
      ),
    );
    const client = new ReviewServiceClient(url, env);
    await expect(client.query(queryRef, {})).rejects.toThrow('Convex service request failed');
  });

  it.each([
    {},
    { value: 'not-a-jwt' },
    { value: token(0) },
  ])('rejects malformed or expired tokens %j', async (response) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    const client = new ReviewServiceClient(url, env);
    await expect(client.action(actionRef, {})).rejects.toThrow('Unable to authenticate');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
