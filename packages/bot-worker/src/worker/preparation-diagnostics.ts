import { stripVTControlCharacters } from 'node:util';

/** Reviewed commands and remote cache failures must not publish credentials or control text. */
export function preparationDiagnostic(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /token|secret|password|private_key|auth_json/i.test(name))
      text = text.split(value).join('[redacted]');
  }
  text = stripVTControlCharacters(text)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[redacted]',
    )
    .replace(/https?:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, 'https://[redacted]@')
    .replace(/\b(?:github_pat_|gh[opusr]_)[a-zA-Z0-9_]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(
      /(["']?[\w-]*(?:token|password|secret|authorization|_auth)[\w-]*["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/([?&](?:sig|signature|credential|key|access_token)=)[^\s&]+/gi, '$1[redacted]')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 1800 ? `${text.slice(0, 880)} [output truncated] ${text.slice(-880)}` : text;
}

export function preparationDiagnosticMarkdown(error: unknown): string {
  return preparationDiagnostic(error)
    .replace(/[\\`*_[\]<>]/g, '\\$&')
    .replace(/@/g, '@\u200b');
}
