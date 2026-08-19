import { performance } from 'node:perf_hooks';
import type { DaemonMetrics, MetricTags } from './types.js';

export interface StatsDMetricOptions {
  tags?: Record<string, string>;
  cardinality?: 'low' | 'orchestrator' | 'high' | 'none';
}

export interface StatsDTransportClient {
  increment(name: string, value: number, options?: StatsDMetricOptions): void;
  timing(name: string, value: number, options?: StatsDMetricOptions): void;
  histogram(name: string, value: number, options?: StatsDMetricOptions): void;
  distribution(name: string, value: number, options?: StatsDMetricOptions): void;
  gauge(name: string, value: number, options?: StatsDMetricOptions): void;
  flush(callback?: (error?: Error) => void): void;
  close(callback?: (error?: Error) => void): void;
}

export type MetricsErrorReporter = (error: Error) => void;

const METRIC_NAME = /^[a-z][a-z0-9_.-]{0,127}$/;
const ALLOWED_TAG_KEYS = new Set([
  'job',
  'method',
  'mode',
  'outcome',
  'route',
  'scope',
  'service',
  'status',
  'status_code',
  'transport',
]);
const UUID_VALUE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? '_' : character;
    })
    .join('');
}

/**
 * Runtime tags are allow-listed intentionally. Adding a tag dimension is a
 * reviewable policy change rather than an unbounded call-site choice.
 */
export function sanitizeMetricTags(tags: MetricTags | undefined): Record<string, string> {
  if (!tags) return {};
  const sanitized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(tags).slice(0, 12)) {
    if (!ALLOWED_TAG_KEYS.has(key)) continue;
    const value = replaceControlCharacters(String(rawValue)).slice(0, 120);
    if (!value || UUID_VALUE.test(value)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function combineTags(base: MetricTags | undefined, extra: MetricTags | undefined): MetricTags {
  return { ...(base ?? {}), ...(extra ?? {}) };
}

/** Failure-isolating adapter around the small hot-shots API surface Agor uses. */
export class StatsDDaemonMetrics implements DaemonMetrics {
  readonly enabled = true;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly client: StatsDTransportClient,
    private readonly reportError: MetricsErrorReporter = () => undefined,
    private readonly lifecycleTimeoutMs = 1_000
  ) {}

  increment(name: string, value = 1, tags?: MetricTags): void {
    this.emit(name, value, tags, (options) => this.client.increment(name, value, options));
  }

  decrement(name: string, value = 1, tags?: MetricTags): void {
    const decrement = -Math.abs(value);
    this.emit(name, decrement, tags, (options) => this.client.increment(name, decrement, options));
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    this.emit(name, value, tags, (options) => this.client.gauge(name, value, options));
  }

  histogram(name: string, value: number, tags?: MetricTags): void {
    this.emit(name, value, tags, (options) => this.client.histogram(name, value, options));
  }

  timing(name: string, milliseconds: number, tags?: MetricTags): void {
    this.emit(name, milliseconds, tags, (options) =>
      this.client.timing(name, milliseconds, options)
    );
  }

  distribution(name: string, value: number, tags?: MetricTags): void {
    this.emit(name, value, tags, (options) => this.client.distribution(name, value, options));
  }

  startTimer(name: string, tags?: MetricTags): (additionalTags?: MetricTags) => number {
    if (this.closed || !METRIC_NAME.test(name)) return () => 0;
    const start = performance.now();
    return (additionalTags?: MetricTags) => {
      const elapsed = Math.max(0, performance.now() - start);
      this.timing(name, elapsed, combineTags(tags, additionalTags));
      return elapsed;
    };
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.runLifecycleCallback((callback) => this.client.flush(callback));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.runLifecycleCallback((callback) => this.client.close(callback));
    return this.closePromise;
  }

  private emit(
    name: string,
    value: number,
    tags: MetricTags | undefined,
    send: (options: StatsDMetricOptions) => void
  ): void {
    if (this.closed || !METRIC_NAME.test(name) || !Number.isFinite(value)) return;
    try {
      send({ tags: sanitizeMetricTags(tags), cardinality: 'low' });
    } catch (error) {
      this.reportSafely(asError(error));
    }
  }

  private runLifecycleCallback(
    operation: (callback: (error?: Error) => void) => void
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) this.reportSafely(error);
        resolve();
      };
      const timeout = setTimeout(() => finish(), this.lifecycleTimeoutMs);
      timeout.unref?.();
      try {
        operation(finish);
      } catch (error) {
        finish(asError(error));
      }
    });
  }

  private reportSafely(error: Error): void {
    try {
      this.reportError(error);
    } catch {
      // Metrics reporting must not create a second failure path.
    }
  }
}
