export function generatedAgentRuntimes(model, fastModeAgents = '') {
  const keys = ['logic', 'security', 'convex'];
  const fast = fastModeAgents
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  for (const key of fast) {
    if (!keys.includes(key)) throw new Error(`Unknown fast-mode Agent: ${key}`);
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        vendor: 'codex',
        model,
        effort: 'xhigh',
        ...(fast.includes(key) ? { fastMode: true } : {}),
      },
    ]),
  );
}
