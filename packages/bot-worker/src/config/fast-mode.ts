import type { AgentVendor } from '@sandy/shared-types';

export function parseFastMode(
  value: unknown,
  vendor: AgentVendor,
  where: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (vendor !== 'codex') throw new Error(`${where} is only supported for vendor codex`);
  if (typeof value !== 'boolean') throw new Error(`${where} must be a boolean`);
  return value;
}
