/** A local Review that cannot start as requested; the CLI exits with status 2. */
export class LocalReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalReviewInputError';
  }
}

/** The abort reason for SIGINT or SIGTERM; the CLI exits with the shell's `128 + n` status. */
export class LocalReviewInterrupted extends Error {
  readonly exitCode: number;

  constructor(signal: 'SIGINT' | 'SIGTERM') {
    super(`Interrupted by ${signal}`);
    this.name = 'LocalReviewInterrupted';
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}
