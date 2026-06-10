import type { AgentEffort, AgentVendor } from '@sandy/shared-types';

/**
 * The per-vendor reasoning-effort vocabularies — the single place they live.
 * Each list mirrors what the pinned Sandcastle (0.6.5) provider options accept
 * for the vendor CLI versions baked into the agent image, so a value that
 * passes validation here is guaranteed to render as a CLI flag (codex
 * `-c model_reasoning_effort="…"`, claude/copilot `--effort …`). Cursor has no
 * effort support in Sandcastle, so its vocabulary is empty and any configured
 * effort is a load-time error. A CLI/Sandcastle bump that adds a level is a
 * one-line update here.
 */
export const VENDOR_EFFORTS: Record<AgentVendor, readonly AgentEffort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  copilot: ['low', 'medium', 'high'],
  cursor: [],
};

/**
 * Validate an optional `effort` value against `vendor`'s vocabulary. Absent
 * (`undefined`) means "use the vendor CLI default" and passes through. Throws
 * on a vendor that takes no effort (cursor) or a value outside the vendor's
 * vocabulary; `where` must name the offending file or config path so the
 * error is actionable at startup.
 */
export function parseEffort(
  value: unknown,
  vendor: AgentVendor,
  where: string,
): AgentEffort | undefined {
  if (value === undefined) {
    return undefined;
  }
  const allowed = VENDOR_EFFORTS[vendor];
  if (allowed.length === 0) {
    throw new Error(`${where} is not supported for vendor ${vendor}`);
  }
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (typeof trimmed !== 'string' || !allowed.includes(trimmed as AgentEffort)) {
    throw new Error(
      `${where} must be one of ${allowed.join(', ')} for vendor ${vendor}, got ${JSON.stringify(value)}`,
    );
  }
  return trimmed as AgentEffort;
}
