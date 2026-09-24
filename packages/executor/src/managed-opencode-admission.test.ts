import { OPENCODE_OBSERVER_BUSY_REASON } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { beginManagedOpenCodeWithBusyRetry } from './managed-opencode-admission';

const busy = () => ({ code: 429, data: { reason: OPENCODE_OBSERVER_BUSY_REASON } });

describe('managed OpenCode admission capacity retry', () => {
  it('retries only typed helper saturation with bounded pre-I/O delays', async () => {
    const begin = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue('admitted');
    const waits: number[] = [];
    const result = await beginManagedOpenCodeWithBusyRetry(
      begin,
      new AbortController().signal,
      () => false,
      async (ms) => {
        waits.push(ms);
      },
      () => 0
    );
    expect(result).toBe('admitted');
    expect(begin).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([150, 300]);
  });

  it('does not retry another rate limit or a stopped admission', async () => {
    const begin = vi.fn().mockRejectedValue({ code: 429, data: { reason: 'other' } });
    await expect(
      beginManagedOpenCodeWithBusyRetry(begin, new AbortController().signal, () => false)
    ).rejects.toMatchObject({ code: 429 });
    expect(begin).toHaveBeenCalledTimes(1);

    const stopped = vi.fn().mockRejectedValue(busy());
    await expect(
      beginManagedOpenCodeWithBusyRetry(stopped, new AbortController().signal, () => true)
    ).rejects.toThrow(/stopped/);
    expect(stopped).not.toHaveBeenCalled();
  });

  it('stops after five waits even when capacity remains busy', async () => {
    const begin = vi.fn().mockRejectedValue(busy());
    const waits: number[] = [];
    await expect(
      beginManagedOpenCodeWithBusyRetry(
        begin,
        new AbortController().signal,
        () => false,
        async (ms) => {
          waits.push(ms);
        },
        () => 0
      )
    ).rejects.toMatchObject({ code: 429 });
    expect(begin).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([150, 300, 600, 1_200, 2_400]);
  });
});
