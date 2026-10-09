import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDedicatedBenchmarkDiagnostics } from './agent-failure-diagnostics.js';

it('keeps excerpts withheld when seed authentication could not be captured', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sandy-diagnostic-no-seed-'));
  try {
    const diagnostics = await createDedicatedBenchmarkDiagnostics(home);
    await writeFile(
      join(home, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: 'later', refresh_token: 'later', id_token: 'later' },
      }),
    );
    await diagnostics.capture();
    expect(await diagnostics.describe(new Error('unknown seed'))).toEqual({
      messageLength: 12,
      excerpt: null,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('withholds oversized or unverifiable details and redacts unknown authentication and identifiers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sandy-diagnostic-bound-'));
  try {
    const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-inner' } })).toString('base64url')}.signature`;
    await writeFile(
      join(home, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'known-short',
          refresh_token: 'known-refresh',
          id_token: jwt,
          account_id: 'acct-short',
        },
      }),
    );
    const diagnostics = await createDedicatedBenchmarkDiagnostics(home);
    const unsafe =
      'Bearer tiny Authorization: "Basic tiny-two" eyAbCd.eyEfGh.signature https://short.test/a https:\\/\\/short.test\\/b https%3A%2F%2Fshort.test%2Fc person@short.test UnknownOpaque123456 acct-inner';
    const result = await diagnostics.describe(new Error(`Reason: ${unsafe}`));
    expect(result.excerpt).toContain('Reason:');
    for (const value of ['tiny', 'eyAbCd', 'short.test', 'UnknownOpaque123456', 'acct-inner'])
      expect(result.excerpt).not.toContain(value);
    const oversized = await diagnostics.describe(
      new Error('x'.repeat(65_537), { cause: 'y'.repeat(65_537) }),
    );
    expect(oversized).toEqual({
      messageLength: 65_537,
      excerpt: null,
      detailsLength: 65_537,
      detailsExcerpt: null,
    });
    await rm(join(home, 'auth.json'));
    expect(
      await diagnostics.describe(
        new Error('Sensitive native message', { cause: 'Sensitive native details' }),
      ),
    ).toEqual({
      messageLength: 24,
      excerpt: null,
      detailsLength: 24,
      detailsExcerpt: null,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('redacts seed, rotated and current authentication before bounding native failure excerpts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sandy-diagnostic-auth-'));
  const credentials = ['seed$secret/one', 'rotated$secret/two', 'current$secret/three'];
  const account = 'acct-short';
  const variants = (value: string) => [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value).toString('base64'),
    Buffer.from(value).toString('base64url'),
    encodeURIComponent(Buffer.from(value).toString('base64')),
    Array.from(value)
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  ];
  const auth = (token: string) => ({
    auth_mode: 'chatgpt',
    tokens: { access_token: token, refresh_token: token, id_token: token, account_id: account },
  });
  try {
    await writeFile(join(home, 'auth.json'), JSON.stringify(auth(credentials[0] ?? '')));
    const diagnostics = await createDedicatedBenchmarkDiagnostics(home);
    await writeFile(join(home, 'auth.json'), JSON.stringify(auth(credentials[1] ?? '')));
    await diagnostics.capture();
    await writeFile(join(home, 'auth.json'), JSON.stringify(auth(credentials[2] ?? '')));
    const secretForms = [...credentials.flatMap(variants), ...variants(account)];
    const error = new Error(`Native failure: ${secretForms.join(' ')}; brief useful reason`, {
      cause: `Additional native details: ${secretForms.join(' ')}`,
    });
    const result = await diagnostics.describe(error);
    expect(result.messageLength).toBe(error.message.length);
    expect(result.detailsLength).toBe(String(error.cause).length);
    expect(result.excerpt).toContain('Native failure:');
    expect(result.excerpt?.length).toBeLessThanOrEqual(1024);
    for (const form of secretForms) expect(JSON.stringify(result)).not.toContain(form);

    const boundary = new Error(`${'short '.repeat(169)}${credentials[0]} final`);
    const bounded = await diagnostics.describe(boundary);
    expect(bounded.excerpt?.length).toBeLessThanOrEqual(1024);
    expect(bounded.excerpt).not.toContain('seed$');
    expect(bounded.excerpt).toContain('[REDACTED]');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
