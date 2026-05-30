import { createHmac, timingSafeEqual } from 'node:crypto';

/** The signature scheme GitHub uses for the `X-Hub-Signature-256` header. */
const PREFIX = 'sha256=';

/**
 * Compute the expected `X-Hub-Signature-256` value for a raw request body: the
 * lowercase hex HMAC-SHA256 of the body under the webhook secret, prefixed with
 * `sha256=`. GitHub signs the RAW bytes, so the caller must pass the unparsed
 * body buffer — re-serializing the JSON would change the bytes and break the
 * match.
 */
export function computeSignature(secret: string, rawBody: Buffer | string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(rawBody);
  return `${PREFIX}${hmac.digest('hex')}`;
}

/**
 * Verify a GitHub webhook signature against the raw body in constant time. A
 * missing or malformed header, or any mismatch, returns `false`; only a header
 * that matches the computed HMAC returns `true`.
 *
 * The comparison is length-checked first (mismatched lengths can't be a valid
 * signature and `timingSafeEqual` throws on unequal-length buffers), then run
 * through `timingSafeEqual` so a wrong signature leaks no timing information.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): boolean {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith(PREFIX)) {
    return false;
  }
  const expected = Buffer.from(computeSignature(secret, rawBody), 'utf8');
  const provided = Buffer.from(signatureHeader, 'utf8');
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
