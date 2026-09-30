import { describe, expect, it } from 'vitest';
import { runWithLimit } from './promisePool';

describe('runWithLimit', () => {
  it('runs every item, never more than the limit at once, and returns the failures', async () => {
    let running = 0;
    let peak = 0;
    const failed = await runWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      if (n % 3 === 0) throw new Error(`no ${n}`);
    });
    expect(peak).toBe(3);
    expect(failed.sort()).toEqual([3, 6]);
  });

  it('still runs every item, one at a time, for a limit below one', async () => {
    const seen: number[] = [];
    expect(await runWithLimit([1, 2], 0, async (n) => void seen.push(n))).toEqual([]);
    expect(seen).toEqual([1, 2]);
  });

  it('resolves at once for no items', async () => {
    expect(await runWithLimit([], 3, async () => {})).toEqual([]);
  });
});
