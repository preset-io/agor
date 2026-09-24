import { getHeapStatistics } from 'node:v8';
import type { ExecutorMemorySample } from '@agor/core/types';

/** Current wrapper-process bytes only. No I/O, async work, history or peak state.
 * Container/node/child metrics belong to the cloud infrastructure collector. */
export function sampleExecutorMemory(): ExecutorMemorySample | undefined {
  try {
    const usage = process.memoryUsage();
    return {
      current: {
        rss: usage.rss,
        heap_used: usage.heapUsed,
        heap_total: usage.heapTotal,
        heap_limit: getHeapStatistics().heap_size_limit,
        external: usage.external,
        // arrayBuffers is already included in external; never sum them.
        ...(usage.arrayBuffers === undefined ? {} : { array_buffers: usage.arrayBuffers }),
      },
    };
  } catch {
    // Optional diagnostics must never prevent a runtime-authority/liveness write.
    return undefined;
  }
}
