import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../test/harness';
import { createIdReader, idReadRetryDelayMs } from './idReads';

afterEach(() => {
  vi.useRealTimers();
});

describe('createIdReader dispose', () => {
  it('is terminal: a read that fails after it is not retried, and nothing more is sent', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = deferred<ReadonlySet<string> | null>();
    const read = vi.fn((_chunk: string[]) => first.promise);
    const reader = createIdReader({ read, isCurrent: () => true });
    reader.queue(['a']);
    expect(read).toHaveBeenCalledTimes(1);

    reader.dispose();
    first.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(10 * idReadRetryDelayMs(1));
    reader.queue(['b']);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
