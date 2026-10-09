import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDedicatedBenchmarkDiagnostics } from './agent-failure-diagnostics.js';

it('withholds entities, controls, non-ASCII and unsupported syntax while retaining ordinary native prose', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sandy-diagnostic-prose-'));
  try {
    await writeFile(
      join(home, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'seedlogin',
          refresh_token: 'seedlogin',
          id_token: 'seedlogin',
        },
      }),
    );
    const diagnostics = await createDedicatedBenchmarkDiagnostics(home);
    for (const message of [
      '&#115;&#101;&#101;&#100;&#108;&#111;&#103;&#105;&#110;',
      '&#x73;&#x65;&#x65;&#x64;&#x6c;&#x6f;&#x67;&#x69;&#x6e;',
      '&amp;seedlogin',
      'native\nerror',
      'native\tError',
      'native\u200berror',
      'native erreur é',
      'native <error>',
      'native {error}',
      'native [115,101]',
      'native a=b',
      'native a+b',
      'native a/b',
      'native person@short.test',
    ])
      expect(await diagnostics.describe(new Error(message, { cause: message }))).toEqual({
        messageLength: message.length,
        excerpt: null,
        detailsLength: message.length,
        detailsExcerpt: null,
      });
    expect(
      await diagnostics.describe(new Error('Native request failed: no tool output for this call.')),
    ).toEqual({
      messageLength: 52,
      excerpt: 'Native request failed: no tool output for this call.',
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('withholds recoverable uppercase, mixed and nested encoded credentials in message and details', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sandy-diagnostic-escape-'));
  const credential = 'KnownLoginAa2bb3CC456';
  const unicode = (character: string) =>
    `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  const escaped = credential.split('').map(unicode).join('');
  const mixed = credential
    .split('')
    .map((character, index) => (index % 4 === 0 ? unicode(character) : character))
    .join('');
  try {
    await writeFile(
      join(home, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: credential,
          refresh_token: 'seed$secret/one',
          id_token: credential,
        },
      }),
    );
    const diagnostics = await createDedicatedBenchmarkDiagnostics(home);
    for (const encoded of [
      escaped,
      mixed,
      escaped.replaceAll('\\', '\\\\'),
      encodeURIComponent(escaped),
      escaped.replaceAll('\\u', '%u'),
      'seed$secret\\/one',
      'seed$secret\\\\/one',
      encodeURIComponent(encodeURIComponent(mixed)),
      credential
        .split('')
        .map((character, index) =>
          index % 4 === 0
            ? encodeURIComponent(character).replace(
                character,
                `%${character.charCodeAt(0).toString(16)}`,
              )
            : character,
        )
        .join(''),
    ]) {
      const message = `Native fault ${encoded}`;
      const details = `Native detail ${encoded}`;
      expect(await diagnostics.describe(new Error(message, { cause: details }))).toEqual({
        messageLength: message.length,
        excerpt: null,
        detailsLength: details.length,
        detailsExcerpt: null,
      });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

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
      'Bearer tiny Authorization: "Basic tiny-two" eyAbCd.eyEfGh.signature UnknownOpaque123456 acct-inner';
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
  const credentials = ['seedlogin', 'rotalogin', 'currlogin'];
  const account = 'acctlogin';
  const variants = (value: string) => [
    value,
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString('base64'),
    Buffer.from(value).toString('base64url'),
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
    expect(bounded.excerpt).not.toContain('seedlo');
    expect(bounded.excerpt).toContain('[REDACTED]');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
