import type { AgentEffort, AgentVendor } from '@sandy/shared-types';

/**
 * Config validation retains legacy vendor vocabularies for existing instance
 * files. The GitHub Actions runtime rejects non-Codex Agents before execution.
 * Codex effort is passed as `model_reasoning_effort` in its CLI config.
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
