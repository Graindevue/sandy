import { readDedicatedBenchmarkAuth } from './dedicated-auth.js';

interface SafeFailureDiagnostic {
  messageLength: number;
  excerpt: string | null;
  detailsLength?: number;
  detailsExcerpt?: string | null;
}

/** Private benchmark artifacts only; all credentials stay in trusted memory. */
export async function createDedicatedBenchmarkDiagnostics(ciHome: string): Promise<{
  capture(): Promise<void>;
  describe(error: unknown): Promise<SafeFailureDiagnostic>;
}> {
  const secrets = new Set<string>();
  const capture = async () => {
    const auth = await readDedicatedBenchmarkAuth(ciHome);
    for (const value of Object.values(auth.tokens)) {
      if (typeof value !== 'string' || value === '') continue;
      for (const encoded of secretForms(value)) secrets.add(encoded);
      const payload = value.split('.')[1];
      if (payload === undefined) continue;
      try {
        const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) continue;
        const nested =
          'https://api.openai.com/auth' in claims
            ? claims['https://api.openai.com/auth']
            : undefined;
        for (const record of [claims, nested]) {
          if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
          for (const [key, identifier] of Object.entries(record))
            if (
              typeof identifier === 'string' &&
              identifier !== '' &&
              /account.?id|user.?id|^sub$|^email$/i.test(key)
            )
              for (const encoded of secretForms(identifier)) secrets.add(encoded);
        }
      } catch {
        // A non-JWT token is still fully covered by its known literal and encoded forms.
      }
    }
  };
  let seedCaptured = false;
  try {
    await capture();
    seedCaptured = true;
  } catch {
    // Missing seed evidence permanently withholds excerpts without affecting healthy Agents.
  }
  return {
    capture,
    async describe(error) {
      const message = error instanceof Error ? error.message : '';
      const details =
        error instanceof Error && typeof error.cause === 'string' ? error.cause : undefined;
      const result: SafeFailureDiagnostic = {
        messageLength: message.length,
        excerpt: null,
        ...(details !== undefined ? { detailsLength: details.length, detailsExcerpt: null } : {}),
      };
      if (!seedCaptured) return result;
      try {
        await capture();
      } catch {
        // Without current auth capture there is no safe excerpt, even on an Agent failure.
        return result;
      }
      result.excerpt = sanitize(message, secrets);
      if (details !== undefined) result.detailsExcerpt = sanitize(details, secrets);
      return result;
    },
  };
}

function secretForms(value: string): string[] {
  const forms = new Set([
    value,
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString('base64'),
    Buffer.from(value).toString('base64url'),
    value
      .split('')
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  ]);
  for (const form of [...forms]) {
    forms.add(encodeURIComponent(form));
    forms.add(encodeURI(form));
    forms.add(new URLSearchParams({ value: form }).toString().slice(6));
    if (form.endsWith('=')) forms.add(form.replace(/=+$/, ''));
  }
  for (const form of [...forms])
    forms.add(form.replace(/%[\dA-F]{2}/g, (match) => match.toLowerCase()));
  return [...forms];
}

function sanitize(message: string, secrets: Set<string>): string | null {
  if (Buffer.byteLength(message, 'utf8') > 65_536) return null;
  let safe = message;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length))
    safe = safe.replaceAll(secret, '[REDACTED]');
  safe = safe
    .replace(/\bAuthorization\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,}]+)/gi, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>,;]+/gi, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:[a-z][a-z0-9+.-]*:(?:\\?\/){2}|www\.)[^\s<>"']+/gi, '[REDACTED]')
    .replace(/\b(?:https?|wss?|ftp)%3a%2f%2f[^\s<>"']+/gi, '[REDACTED]')
    .replace(/[^\s<>"'@]+@[^\s<>"'@]+\.[A-Za-z]+/g, '[REDACTED]')
    .replace(/[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return safe.slice(0, 1024);
}
