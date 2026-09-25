import { afterEach, expect, it, vi } from 'vitest';
import { sampleExecutorMemory } from './executor-memory.js';

afterEach(() => vi.restoreAllMocks());

it('returns only synchronous current wrapper counters, without retained peaks', () => {
  const usage = vi.spyOn(process, 'memoryUsage');
  usage.mockReturnValue({ rss: 100, heapUsed: 80, heapTotal: 90, external: 20, arrayBuffers: 10 });
  const first = sampleExecutorMemory();
  expect(first).toEqual({
    current: {
      rss: 100,
      heap_used: 80,
      heap_total: 90,
      heap_limit: expect.any(Number),
      external: 20,
      array_buffers: 10,
    },
  });
  usage.mockReturnValue({
    rss: 50,
    heapUsed: 40,
    heapTotal: 45,
    external: 10,
  } as NodeJS.MemoryUsage);
  expect(sampleExecutorMemory()).toEqual({
    current: {
      rss: 50,
      heap_used: 40,
      heap_total: 45,
      heap_limit: expect.any(Number),
      external: 10,
    },
  });
});

it('omits failed observations rather than preventing a heartbeat', () => {
  vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
    throw new Error('unavailable');
  });
  expect(sampleExecutorMemory()).toBeUndefined();
});
