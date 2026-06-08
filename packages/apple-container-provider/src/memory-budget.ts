/**
 * Aggregate memory budget for container VMs.
 *
 * Each Apple Container VM reserves a fixed slice of host RAM. Without a cap,
 * N concurrent agents commit N × per-VM memory, which can overcommit the host
 * and panic it (launchd SIGBUS / "initproc exited"). This module gates VM
 * creation on a shared budget so the running fleet can never reserve more than
 * `limitMb` at once — the backpressure that bounds aggregate guest RAM.
 */

/** Parse an Apple `--memory` string ('8g', '512m', '1024') to MiB. Returns 0 if unparseable. */
export function parseMemoryToMb(memory: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg])?b?\s*$/i.exec(memory);
  if (match === null) {
    return 0;
  }
  const value = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case 'g':
      return Math.ceil(value * 1024);
    case 'k':
      return Math.ceil(value / 1024);
    default:
      // 'm' or no unit: Apple treats a bare number as bytes, but our callers
      // only ever pass gibibyte/mebibyte strings, so a bare number is MiB.
      return Math.ceil(value);
  }
}

export interface MemoryBudget {
  /** Total budget in MiB. */
  readonly limitMb: number;
  /** Currently reserved MiB. */
  reservedMb(): number;
  /** Callers waiting for room. */
  pendingCount(): number;
  /**
   * Reserve `mb`, resolving once the fleet has room. The resolved function
   * releases the reservation (idempotent) and admits any waiters that now fit.
   * A reservation larger than the whole budget is admitted alone — when nothing
   * else holds the budget — so a single oversized VM can never deadlock.
   */
  acquire(mb: number): Promise<() => void>;
}

export function createMemoryBudget(limitMb: number): MemoryBudget {
  let reserved = 0;
  const waiters: { mb: number; resolve: (release: () => void) => void }[] = [];

  // Room exists when the budget is idle (lets an oversized VM run alone) or the
  // reservation still fits under the limit.
  const fits = (mb: number): boolean => reserved === 0 || reserved + mb <= limitMb;

  const grant = (mb: number): (() => void) => {
    reserved += mb;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      reserved = Math.max(0, reserved - mb);
      drain();
    };
  };

  const drain = (): void => {
    for (let head = waiters[0]; head !== undefined && fits(head.mb); head = waiters[0]) {
      waiters.shift();
      head.resolve(grant(head.mb));
    }
  };

  return {
    limitMb,
    reservedMb: () => reserved,
    pendingCount: () => waiters.length,
    acquire: (mb: number): Promise<() => void> => {
      const need = Math.max(0, mb);
      // Grant immediately only when nothing is already queued; otherwise wait in
      // line. This keeps admission FIFO even when a later, smaller reservation
      // would fit under the limit, so a larger queued VM can't be starved by a
      // stream of smaller arrivals. (In practice every VM in a process is the
      // same size, so this never changes admission — it just makes the FIFO
      // contract hold for any sizes rather than by accident.)
      if (waiters.length === 0 && fits(need)) {
        return Promise.resolve(grant(need));
      }
      return new Promise<() => void>((resolve) => {
        waiters.push({ mb: need, resolve });
      });
    },
  };
}
