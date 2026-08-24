import type { DaemonMetrics, MetricTimer } from './types.js';

const stopNoopTimer: MetricTimer = () => 0;

export const NOOP_METRICS: DaemonMetrics = Object.freeze({
  enabled: false,
  increment: () => undefined,
  decrement: () => undefined,
  gauge: () => undefined,
  histogram: () => undefined,
  timing: () => undefined,
  distribution: () => undefined,
  startTimer: () => stopNoopTimer,
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
});
