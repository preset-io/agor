import { describe, expect, it, vi } from 'vitest';
import { runKeyedSingleFlight } from './keyed-single-flight.js';

describe('runKeyedSingleFlight', () => {
  it('joins concurrent work for one key and allows a new run after settlement', async () => {
    const inFlight = new Map<string, Promise<string>>();
    let finish!: (value: string) => void;
    const work = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );

    const first = runKeyedSingleFlight(inFlight, 'session-1', work);
    const second = runKeyedSingleFlight(inFlight, 'session-1', work);
    expect(work).toHaveBeenCalledOnce();

    finish('stopped');
    await expect(Promise.all([first, second])).resolves.toEqual(['stopped', 'stopped']);
    expect(inFlight).toHaveLength(0);

    const third = runKeyedSingleFlight(inFlight, 'session-1', async () => 'stopped-again');
    await expect(third).resolves.toBe('stopped-again');
    expect(work).toHaveBeenCalledOnce();
  });
});
