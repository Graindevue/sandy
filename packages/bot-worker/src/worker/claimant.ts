import { api } from '@sandy/convex-backend/api';

export interface PendingReviewJob {
  _id: string;
}

export interface ClaimantLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ReactiveConvexClient {
  onUpdate(
    query: unknown,
    args: Record<string, never>,
    callback: (jobs: PendingReviewJob[]) => void,
    onError?: (error: Error) => void,
  ): { unsubscribe: () => void } | (() => void);
  mutation(mutation: unknown, args: { jobId: string; claimedAt: number }): Promise<boolean>;
}

export interface ReviewClaimantOptions {
  client: ReactiveConvexClient;
  handleClaimedJob(jobId: string): Promise<void>;
  logger?: ClaimantLogger;
  now?: () => number;
  maxConcurrentJobs?: number;
}

const defaultLogger: ClaimantLogger = console;
const DEFAULT_MAX_CONCURRENT_JOBS = 1;

export class ReviewClaimant {
  readonly #client: ReactiveConvexClient;
  readonly #handleClaimedJob: (jobId: string) => Promise<void>;
  readonly #logger: ClaimantLogger;
  readonly #now: () => number;
  readonly #semaphore: AsyncSemaphore;
  readonly #inFlight = new Set<string>();

  constructor(options: ReviewClaimantOptions) {
    this.#client = options.client;
    this.#handleClaimedJob = options.handleClaimedJob;
    this.#logger = options.logger ?? defaultLogger;
    this.#now = options.now ?? Date.now;
    this.#semaphore = new AsyncSemaphore(options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS);
  }

  start(): () => void {
    const subscription = this.#client.onUpdate(
      api.reviewJobs.subscribePending,
      {},
      (jobs) => {
        for (const job of jobs) {
          void this.#claimAndProcess(job._id);
        }
      },
      (error) => {
        this.#logger.error('subscribePending failed', error);
      },
    );

    return () => {
      if (typeof subscription === 'function') {
        subscription();
      } else {
        subscription.unsubscribe();
      }
    };
  }

  async #claimAndProcess(jobId: string): Promise<void> {
    if (this.#inFlight.has(jobId)) {
      return;
    }
    this.#inFlight.add(jobId);
    const release = await this.#semaphore.acquire();

    try {
      const claimed = await this.#client.mutation(api.reviewJobs.claim, {
        jobId,
        claimedAt: this.#now(),
      });
      if (!claimed) {
        this.#logger.info(`ReviewJob ${jobId} was already claimed`);
        return;
      }
      await this.#handleClaimedJob(jobId);
    } catch (error) {
      this.#logger.error(`ReviewJob ${jobId} execution failed`, error);
    } finally {
      release();
      this.#inFlight.delete(jobId);
    }
  }
}

class AsyncSemaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`maxConcurrentJobs must be a positive integer, got ${maxConcurrent}`);
    }
    this.#available = maxConcurrent;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return () => this.#release();
    }

    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
    return () => this.#release();
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) {
      this.#available += 1;
      return;
    }
    next();
  }
}
