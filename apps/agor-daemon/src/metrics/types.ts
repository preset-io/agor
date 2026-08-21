export type MetricTagValue = string | number | boolean;
export type MetricTags = Readonly<Record<string, MetricTagValue>>;

export type MetricTimer = (additionalTags?: MetricTags) => number;

/**
 * Daemon operational metrics boundary.
 *
 * Implementations must be failure-isolating: callers never catch exporter
 * errors, and the disabled implementation is a cheap no-op.
 */
export interface DaemonMetrics {
  readonly enabled: boolean;
  increment(name: string, value?: number, tags?: MetricTags): void;
  decrement(name: string, value?: number, tags?: MetricTags): void;
  gauge(name: string, value: number, tags?: MetricTags): void;
  histogram(name: string, value: number, tags?: MetricTags): void;
  timing(name: string, milliseconds: number, tags?: MetricTags): void;
  distribution(name: string, value: number, tags?: MetricTags): void;
  startTimer(name: string, tags?: MetricTags): MetricTimer;
  flush(): Promise<void>;
  close(): Promise<void>;
}
