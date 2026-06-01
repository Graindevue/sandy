export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), max));
}
