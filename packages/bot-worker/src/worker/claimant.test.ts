import { describe, expect, it } from 'vitest';
import { type PendingReviewJob, ReviewClaimant } from './claimant.js';

describe('ReviewClaimant', () => {
  it('claims a pending job once and processes it only after the OCC claim wins', async () => {
    const client = new FakeReactiveConvexClient([true]);
    let finishJob!: () => void;
    const processed: string[] = [];

    const claimant = new ReviewClaimant({
      client,
      now: () => 1234,
      logger: silentLogger,
      handleClaimedJob: async (jobId) => {
        processed.push(jobId);
        await new Promise<void>((resolve) => {
          finishJob = resolve;
        });
      },
    });

    const stop = claimant.start();
    client.emit([{ _id: 'job-1' }]);
    client.emit([{ _id: 'job-1' }]);

    await tick();
    expect(client.claimed).toEqual([{ jobId: 'job-1', claimedAt: 1234 }]);
    expect(processed).toEqual(['job-1']);

    finishJob();
    await tick();
    stop();
    expect(client.unsubscribed).toBe(true);
  });

  it('does not process a job when the OCC claim loses', async () => {
    const client = new FakeReactiveConvexClient([false]);
    const processed: string[] = [];

    const claimant = new ReviewClaimant({
      client,
      now: () => 1234,
      logger: silentLogger,
      handleClaimedJob: async (jobId) => {
        processed.push(jobId);
      },
    });

    claimant.start();
    client.emit([{ _id: 'job-1' }]);

    await tick();
    expect(client.claimed).toEqual([{ jobId: 'job-1', claimedAt: 1234 }]);
    expect(processed).toEqual([]);
  });

  it('bounds distinct claimed jobs with maxConcurrentJobs', async () => {
    const client = new FakeReactiveConvexClient([true, true]);
    const processed: string[] = [];
    const finish = new Map<string, () => void>();

    const claimant = new ReviewClaimant({
      client,
      now: () => 1234,
      logger: silentLogger,
      maxConcurrentJobs: 1,
      handleClaimedJob: async (jobId) => {
        processed.push(jobId);
        await new Promise<void>((resolve) => {
          finish.set(jobId, resolve);
        });
      },
    });

    claimant.start();
    client.emit([{ _id: 'job-1' }, { _id: 'job-2' }]);

    await tick();
    expect(client.claimed).toEqual([{ jobId: 'job-1', claimedAt: 1234 }]);
    expect(processed).toEqual(['job-1']);

    finish.get('job-1')?.();
    await tick();
    await tick();
    expect(client.claimed).toEqual([
      { jobId: 'job-1', claimedAt: 1234 },
      { jobId: 'job-2', claimedAt: 1234 },
    ]);
    expect(processed).toEqual(['job-1', 'job-2']);

    finish.get('job-2')?.();
    await tick();
  });
});

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeReactiveConvexClient {
  claimed: { jobId: string; claimedAt: number }[] = [];
  unsubscribed = false;
  #callback: ((jobs: PendingReviewJob[]) => void) | null = null;
  #claimResults: boolean[];

  constructor(claimResults: boolean[]) {
    this.#claimResults = [...claimResults];
  }

  onUpdate(
    _query: unknown,
    _args: Record<string, never>,
    callback: (jobs: PendingReviewJob[]) => void,
  ): { unsubscribe: () => void } {
    this.#callback = callback;
    return {
      unsubscribe: () => {
        this.unsubscribed = true;
      },
    };
  }

  async mutation(_mutation: unknown, args: { jobId: string; claimedAt: number }): Promise<boolean> {
    this.claimed.push(args);
    return this.#claimResults.shift() ?? false;
  }

  emit(jobs: PendingReviewJob[]): void {
    this.#callback?.(jobs);
  }
}
