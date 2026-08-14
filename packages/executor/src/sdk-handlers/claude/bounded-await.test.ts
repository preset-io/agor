import { describe, expect, it, vi } from 'vitest';
import { AWAIT_TIMEOUT, awaitWithTimeout } from './bounded-await.js';

describe('awaitWithTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(awaitWithTimeout(Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
  });

  it('resolves to the timeout sentinel when the promise never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<string>(() => {}); // never settles
      const raced = awaitWithTimeout(pending, 15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(raced).resolves.toBe(AWAIT_TIMEOUT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not raise an unhandled rejection when the losing promise rejects late', async () => {
    vi.useFakeTimers();
    const rejection = vi.fn();
    process.on('unhandledRejection', rejection);
    try {
      let reject!: (error: Error) => void;
      const pending = new Promise<string>((_, r) => {
        reject = r;
      });
      const raced = awaitWithTimeout(pending, 10);
      await vi.advanceTimersByTimeAsync(10);
      expect(await raced).toBe(AWAIT_TIMEOUT);
      // Transport closes after we already timed out and rejects the orphan.
      reject(new Error('transport closed'));
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', rejection);
      vi.useRealTimers();
    }
    expect(rejection).not.toHaveBeenCalled();
  });
});
