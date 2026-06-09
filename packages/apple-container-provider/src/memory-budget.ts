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
   *
   * If `signal` aborts before room is granted, the wait is abandoned: the
   * still-queued reservation is dropped and the promise rejects with the
   * signal's reason. Callers pass `AbortSignal.timeout(...)` to bound the wait —
   * crucially, an abandoned waiter is removed from the queue, so it can never
   * later be granted a slot that nobody holds (which would leak the reservation
   * until the reaper). A signal that aborts after the grant has no effect.
   */
  acquire(mb: number, signal?: AbortSignal): Promise<() => void>;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('memory budget acquisition aborted');
}

export function createMemoryBudget(limitMb: number): MemoryBudget {
  let reserved = 0;
  type Waiter = { mb: number; resolve: (release: () => void) => void };
  const waiters: Waiter[] = [];

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
    acquire: (mb: number, signal?: AbortSignal): Promise<() => void> => {
      const need = Math.max(0, mb);
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }
      // Grant immediately only when nothing is already queued; otherwise wait in
      // line. This keeps admission FIFO even when a later, smaller reservation
      // would fit under the limit, so a larger queued VM can't be starved by a
      // stream of smaller arrivals. (In practice every VM in a process is the
      // same size, so this never changes admission — it just makes the FIFO
      // contract hold for any sizes rather than by accident.)
      if (waiters.length === 0 && fits(need)) {
        return Promise.resolve(grant(need));
      }
      return new Promise<() => void>((resolve, reject) => {
        const removeListener = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          removeListener();
          reject(abortReason(signal));
        };
        // Wrap resolve so a granted waiter detaches its abort listener — a later
        // abort must not touch a reservation the caller already holds.
        const waiter: Waiter = {
          mb: need,
          resolve: (release) => {
            removeListener();
            resolve(release);
          },
        };
        waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
