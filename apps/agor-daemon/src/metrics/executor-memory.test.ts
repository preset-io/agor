import { expect, it, vi } from 'vitest';
import { recordExecutorMemory } from './executor-memory.js';
import { NOOP_METRICS } from './noop.js';

it('exports only fixed numeric fields without any task/tenant/payload labels', () => {
  const distribution = vi.fn();
  const metrics = { ...NOOP_METRICS, enabled: true, distribution };
  recordExecutorMemory(metrics, {
    current: {
      rss: 123,
      heap_used: -1,
      external: NaN,
      secret: 'payload',
      array_buffers: 'payload',
    },
    sampled_peak: { rss: 456 },
    session_id: 'private',
  });
  expect(distribution.mock.calls).toEqual([
    ['executor.memory.current.rss_bytes', 123],
    ['executor.memory.sampled_peak.rss_bytes', 456],
  ]);
  recordExecutorMemory(metrics, { current: null });
  recordExecutorMemory({ ...metrics, enabled: false }, { current: { rss: 1 } });
  expect(distribution).toHaveBeenCalledTimes(2);
});
