import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutputCoalescer } from './zellij.js';

describe('createOutputCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces chunks pushed within a window into a single emit', () => {
    const emit = vi.fn<(data: string) => void>();
    const coalescer = createOutputCoalescer(emit, 16);

    coalescer.push('a');
    coalescer.push('b');
    coalescer.push('c');
    // Nothing emitted synchronously — still buffered.
    expect(emit).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('abc');
  });

  it('flushes early once the byte cap is reached, without waiting for the timer', () => {
    const emit = vi.fn<(data: string) => void>();
    // Small cap so we can trip it without giant strings.
    const coalescer = createOutputCoalescer(emit, 16, 4);

    coalescer.push('ab');
    expect(emit).not.toHaveBeenCalled();
    // This push crosses the 4-byte cap → synchronous flush.
    coalescer.push('cd');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('abcd');

    // Timer flush after an early size flush must not emit an empty frame.
    vi.runAllTimers();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('counts UTF-8 bytes (not UTF-16 code units) against the cap', () => {
    const emit = vi.fn<(data: string) => void>();
    // Cap of 6 bytes. '★' is 3 UTF-8 bytes but a single JS string char, so a
    // char-length check would need 6 chars to trip; a byte check trips at 2.
    const coalescer = createOutputCoalescer(emit, 16, 6);

    coalescer.push('★'); // 3 bytes buffered, under cap
    expect(emit).not.toHaveBeenCalled();
    coalescer.push('★'); // 6 bytes total → hits cap, flush now
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('★★');

    vi.runAllTimers();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh window after a flush', () => {
    const emit = vi.fn<(data: string) => void>();
    const coalescer = createOutputCoalescer(emit, 16);

    coalescer.push('first');
    vi.runAllTimers();
    coalescer.push('second');
    vi.runAllTimers();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, 'first');
    expect(emit).toHaveBeenNthCalledWith(2, 'second');
  });

  it('dispose flushes any buffered tail', () => {
    const emit = vi.fn<(data: string) => void>();
    const coalescer = createOutputCoalescer(emit, 16);

    coalescer.push('tail');
    coalescer.dispose();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('tail');
  });

  it('ignores empty chunks and never emits empty frames', () => {
    const emit = vi.fn<(data: string) => void>();
    const coalescer = createOutputCoalescer(emit, 16);

    coalescer.push('');
    vi.runAllTimers();
    coalescer.flush();
    expect(emit).not.toHaveBeenCalled();
  });
});
