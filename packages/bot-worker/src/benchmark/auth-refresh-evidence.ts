import { readDedicatedBenchmarkAuth } from './dedicated-auth.js';

/** Read-only evidence capture for an explicit test login; native Codex owns refresh and writes. */
export async function observeDedicatedAuthRefresh(
  ciHome: string,
): Promise<{ refreshObserved(): Promise<boolean> }> {
  const initial = await readDedicatedBenchmarkAuth(ciHome);
  const startedAt = Date.now();
  return {
    async refreshObserved() {
      const current = await readDedicatedBenchmarkAuth(ciHome);
      return (
        typeof current.last_refresh === 'string' &&
        Date.parse(current.last_refresh) >= startedAt - 30_000 &&
        ['access_token', 'refresh_token', 'id_token'].some(
          (key) => current.tokens[key] !== initial.tokens[key],
        ) &&
        current.tokens.account_id === initial.tokens.account_id
      );
    },
  };
}
