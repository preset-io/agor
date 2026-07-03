import { describe, expect, it, vi } from 'vitest';
import { batchRealtime, flushRealtimeNow } from './realtimeBatch';

describe('realtimeBatch', () => {
  it('defers the wrapped action until the queue is flushed', () => {
    const spy = vi.fn();
    const handler = batchRealtime(spy);

    handler('a');
    expect(spy).not.toHaveBeenCalled(); // not applied synchronously

    flushRealtimeNow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('a');
  });

  it('coalesces a burst and preserves FIFO order across handlers', () => {
    const calls: string[] = [];
    const a = batchRealtime((p: string) => calls.push(`a:${p}`));
    const b = batchRealtime((p: string) => calls.push(`b:${p}`));

    a('1');
    b('2');
    a('3');
    expect(calls).toEqual([]); // still queued

    flushRealtimeNow();
    expect(calls).toEqual(['a:1', 'b:2', 'a:3']);
  });

  it('flushRealtimeNow is a no-op when the queue is empty', () => {
    expect(() => flushRealtimeNow()).not.toThrow();
  });
});
