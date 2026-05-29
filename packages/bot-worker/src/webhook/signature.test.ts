import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSignature, verifySignature } from './signature.js';

const SECRET = 'it-is-a-test-secret';
const BODY = JSON.stringify({ action: 'opened', number: 1 });

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('computeSignature', () => {
  it('produces the GitHub sha256= HMAC of the raw body', () => {
    expect(computeSignature(SECRET, BODY)).toBe(sign(SECRET, BODY));
  });

  it('matches for Buffer and string bodies alike', () => {
    expect(computeSignature(SECRET, Buffer.from(BODY, 'utf8'))).toBe(
      computeSignature(SECRET, BODY),
    );
  });
});

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    expect(verifySignature(SECRET, BODY, sign(SECRET, BODY))).toBe(true);
  });

  it('accepts a valid signature over a raw Buffer body', () => {
    const raw = Buffer.from(BODY, 'utf8');
    expect(verifySignature(SECRET, raw, sign(SECRET, BODY))).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    expect(verifySignature(SECRET, BODY, sign('wrong-secret', BODY))).toBe(false);
  });

  it('rejects a signature when the body has been tampered with', () => {
    const tampered = `${BODY} `;
    expect(verifySignature(SECRET, tampered, sign(SECRET, BODY))).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifySignature(SECRET, BODY, undefined)).toBe(false);
  });

  it('rejects an empty signature header', () => {
    expect(verifySignature(SECRET, BODY, '')).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const digest = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifySignature(SECRET, BODY, digest)).toBe(false);
  });

  it('rejects a malformed (wrong-length) signature without throwing', () => {
    expect(verifySignature(SECRET, BODY, 'sha256=deadbeef')).toBe(false);
  });

  it('rejects a syntactically valid but incorrect signature', () => {
    const wrong = `sha256=${'0'.repeat(64)}`;
    expect(verifySignature(SECRET, BODY, wrong)).toBe(false);
  });
});
