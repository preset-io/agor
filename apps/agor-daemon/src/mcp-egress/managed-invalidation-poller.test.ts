import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedInvalidationPoller } from './managed-invalidation-poller.js';

afterEach(() => vi.useRealTimers());
describe('managed invalidation polling schedule', () => {
  it('polls immediately and then within 30s plus at most 5s jitter, without overlapping', async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const synchronize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const poller = new ManagedInvalidationPoller({
      synchronize,
      jitterMs: () => 99_000,
      monotonicNow: () => Date.now(),
    });
    poller.start();
    poller.start();
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    complete();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    poller.stop();
    complete();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('bounds requests and reports sanitized unavailability without replacing durable state', async () => {
    vi.useFakeTimers();
    const onUnavailable = vi.fn();
    const synchronize = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('fake-response-not-for-logs')));
        })
    );
    const poller = new ManagedInvalidationPoller({
      synchronize,
      onUnavailable,
      jitterMs: () => 0,
      monotonicNow: () => Date.now(),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(synchronize).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
