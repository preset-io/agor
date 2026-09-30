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

  it('resolves at once for no items', async () => {
    expect(await runWithLimit([], 3, async () => {})).toEqual([]);
  });
});
