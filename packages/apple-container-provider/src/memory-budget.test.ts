import { describe, expect, it } from 'vitest';

import { createMemoryBudget, parseMemoryToMb } from './memory-budget.js';

describe('parseMemoryToMb', () => {
  it('parses gibibyte strings', () => {
    expect(parseMemoryToMb('8g')).toBe(8192);
    expect(parseMemoryToMb('6g')).toBe(6144);
    expect(parseMemoryToMb('1.5g')).toBe(1536);
  });

  it('parses mebibyte and bare numbers as MiB', () => {
    expect(parseMemoryToMb('512m')).toBe(512);
    expect(parseMemoryToMb('1024')).toBe(1024);
  });

  it('tolerates the optional b suffix and whitespace/case', () => {
    expect(parseMemoryToMb('8GB')).toBe(8192);
    expect(parseMemoryToMb('  4g ')).toBe(4096);
  });

  it('returns 0 for unparseable input', () => {
    expect(parseMemoryToMb('lots')).toBe(0);
    expect(parseMemoryToMb('')).toBe(0);
  });
});

describe('createMemoryBudget', () => {
  it('admits reservations that fit and tracks usage', async () => {
    const budget = createMemoryBudget(16_384);
    const release = await budget.acquire(6_144);
    expect(budget.reservedMb()).toBe(6_144);
    release();
    expect(budget.reservedMb()).toBe(0);
  });

  it('queues a reservation that would overcommit until room frees', async () => {
    const budget = createMemoryBudget(16_384);
    const releaseA = await budget.acquire(8_192);
    const releaseB = await budget.acquire(8_192);
    expect(budget.reservedMb()).toBe(16_384);

    let cGranted = false;
    const cPromise = budget.acquire(8_192).then((release) => {
      cGranted = true;
      return release;
    });
    await Promise.resolve();
    expect(cGranted).toBe(false);
    expect(budget.pendingCount()).toBe(1);

    releaseA();
    await cPromise;
    expect(cGranted).toBe(true);
    expect(budget.reservedMb()).toBe(16_384);

    releaseB();
    (await cPromise)();
    expect(budget.reservedMb()).toBe(0);
  });

  it('is idempotent on double release', async () => {
    const budget = createMemoryBudget(8_192);
    const release = await budget.acquire(4_096);
    release();
    release();
    expect(budget.reservedMb()).toBe(0);
  });

  it('admits an oversized reservation alone, then serializes the rest', async () => {
    const budget = createMemoryBudget(4_096);
    const releaseBig = await budget.acquire(8_192);
    expect(budget.reservedMb()).toBe(8_192);

    let smallGranted = false;
    const smallPromise = budget.acquire(1_024).then((release) => {
      smallGranted = true;
      return release;
    });
    await Promise.resolve();
    expect(smallGranted).toBe(false);

    releaseBig();
    (await smallPromise)();
    expect(smallGranted).toBe(true);
    expect(budget.reservedMb()).toBe(0);
  });

  it('keeps admission FIFO when a later smaller reservation would fit', async () => {
    const budget = createMemoryBudget(10_240);
    const releaseFirst = await budget.acquire(8_192);

    // Does not currently fit (8g + 8g > 10g), so it queues.
    let bigGranted = false;
    const big = budget.acquire(8_192).then((release) => {
      bigGranted = true;
      return release;
    });
    // Would fit right now (8g + 1g <= 10g), but must still wait behind the
    // larger reservation rather than jump the queue.
    let smallGranted = false;
    const small = budget.acquire(1_024).then((release) => {
      smallGranted = true;
      return release;
    });
    await Promise.resolve();
    expect(bigGranted).toBe(false);
    expect(smallGranted).toBe(false);
    expect(budget.pendingCount()).toBe(2);

    releaseFirst();
    // Freeing 8g admits the big waiter first (FIFO); the small one follows since
    // 8g + 1g still fits.
    await Promise.all([big, small]);
    expect(bigGranted).toBe(true);
    expect(smallGranted).toBe(true);
    expect(budget.reservedMb()).toBe(9_216);
  });

  it('drains queued waiters in FIFO order as room frees', async () => {
    const budget = createMemoryBudget(10_240);
    const releaseFirst = await budget.acquire(10_240);

    const order: string[] = [];
    const a = budget.acquire(4_096).then((release) => {
      order.push('a');
      return release;
    });
    const b = budget.acquire(4_096).then((release) => {
      order.push('b');
      return release;
    });
    await Promise.resolve();
    expect(budget.pendingCount()).toBe(2);

    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });
});
