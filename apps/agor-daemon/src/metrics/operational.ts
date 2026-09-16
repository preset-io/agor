import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { DaemonMetrics } from './types.js';

export const DAEMON_OPERATIONAL_METRICS_INTERVAL_MS = 15_000;

export type ExternalRequestTransport = 'http' | 'socketio';

type EventLoopDelayHistogram = Pick<
  ReturnType<typeof monitorEventLoopDelay>,
  'count' | 'disable' | 'enable' | 'max' | 'percentile' | 'reset'
>;

export interface DaemonOperationalMetrics {
  readonly enabled: boolean;
  start(): void;
  stop(): void;
  beginExternalRequest(transport: ExternalRequestTransport): () => void;
  recordSocketClientConnection(): (reason: string) => void;
  recordSocketAuthenticationFailure(): void;
}

export interface DaemonOperationalMetricsOptions {
  intervalMs?: number;
  createEventLoopDelayHistogram?: () => EventLoopDelayHistogram;
}

const stopNoop = () => undefined;

export const NOOP_DAEMON_OPERATIONAL_METRICS: DaemonOperationalMetrics = Object.freeze({
  enabled: false,
  start: () => undefined,
  stop: () => undefined,
  beginExternalRequest: () => stopNoop,
  recordSocketClientConnection: () => stopNoop,
  recordSocketAuthenticationFailure: () => undefined,
});

function normalizedDisconnectReason(reason: string): string {
  switch (reason) {
    case 'client namespace disconnect':
      return 'client';
    case 'server namespace disconnect':
      return 'server';
    case 'server shutting down':
      return 'server_shutdown';
    case 'ping timeout':
      return 'ping_timeout';
    case 'transport close':
      return 'transport_close';
    case 'transport error':
      return 'transport_error';
    case 'parse error':
      return 'parse_error';
    case 'forced close':
      return 'forced_close';
    default:
      return 'other';
  }
}

/**
 * Process-local state for passive load signals. All export calls are isolated
 * from request/control flow even though DaemonMetrics implementations already
 * promise the same boundary.
 */
export class ActiveDaemonOperationalMetrics implements DaemonOperationalMetrics {
  readonly enabled = true;
  private readonly inFlight: Record<ExternalRequestTransport, number> = {
    http: 0,
    socketio: 0,
  };
  private activeSocketClients = 0;
  private eventLoopDelayHistogram: EventLoopDelayHistogram | undefined;
  private samplingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly metrics: DaemonMetrics,
    private readonly options: DaemonOperationalMetricsOptions = {}
  ) {}

  start(): void {
    if (this.samplingTimer) return;

    this.emitActiveGauges();
    try {
      this.eventLoopDelayHistogram =
        this.options.createEventLoopDelayHistogram?.() ?? monitorEventLoopDelay({ resolution: 20 });
      this.eventLoopDelayHistogram.enable();
    } catch {
      this.eventLoopDelayHistogram = undefined;
    }

    this.samplingTimer = setInterval(
      () => this.sample(),
      this.options.intervalMs ?? DAEMON_OPERATIONAL_METRICS_INTERVAL_MS
    );
    this.samplingTimer.unref?.();
  }

  stop(): void {
    if (!this.samplingTimer) return;
    clearInterval(this.samplingTimer);
    this.samplingTimer = undefined;
    // Publish terminal zeros even if the socket/request drain timed out.
    this.activeSocketClients = 0;
    this.inFlight.http = 0;
    this.inFlight.socketio = 0;
    this.sample();
    try {
      this.eventLoopDelayHistogram?.disable();
    } catch {
      // Runtime observation must not affect daemon shutdown.
    }
    this.eventLoopDelayHistogram = undefined;
  }

  beginExternalRequest(transport: ExternalRequestTransport): () => void {
    this.inFlight[transport] = Math.min(this.inFlight[transport] + 1, Number.MAX_SAFE_INTEGER);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.inFlight[transport] = Math.max(0, this.inFlight[transport] - 1);
    };
  }

  recordSocketClientConnection(): (reason: string) => void {
    this.activeSocketClients = Math.min(this.activeSocketClients + 1, Number.MAX_SAFE_INTEGER);
    this.emit(() => this.metrics.increment('socketio.client.connections'));
    let disconnected = false;
    return (reason: string) => {
      if (disconnected) return;
      disconnected = true;
      this.activeSocketClients = Math.max(0, this.activeSocketClients - 1);
      this.emit(() =>
        this.metrics.increment('socketio.client.disconnections', 1, {
          disconnect_reason: normalizedDisconnectReason(reason),
        })
      );
    };
  }

  recordSocketAuthenticationFailure(): void {
    this.emit(() => this.metrics.increment('socketio.authentication_failures'));
  }

  private sample(): void {
    this.emitActiveGauges();
    const histogram = this.eventLoopDelayHistogram;
    if (!histogram) return;
    try {
      if (histogram.count === 0) return;
      const observations = [
        ['p50_ms', histogram.percentile(50)],
        ['p90_ms', histogram.percentile(90)],
        ['p99_ms', histogram.percentile(99)],
        ['max_ms', histogram.max],
      ] as const;
      for (const [suffix, nanoseconds] of observations) {
        const milliseconds = Math.max(0, nanoseconds / 1_000_000);
        this.emit(() => this.metrics.gauge(`node.event_loop.delay.${suffix}`, milliseconds));
      }
    } catch {
      // A runtime histogram/exporter failure cannot affect daemon behavior.
    } finally {
      try {
        histogram.reset();
      } catch {
        // Reset failure only loses the next interval's isolation.
      }
    }
  }

  private emitActiveGauges(): void {
    this.emit(() => this.metrics.gauge('socketio.clients.active', this.activeSocketClients));
    this.emit(() =>
      this.metrics.gauge('external_requests.in_flight', this.inFlight.http, {
        transport: 'http',
      })
    );
    this.emit(() =>
      this.metrics.gauge('external_requests.in_flight', this.inFlight.socketio, {
        transport: 'socketio',
      })
    );
  }

  private emit(operation: () => void): void {
    try {
      operation();
    } catch {
      // Preserve the facade's failure-isolation contract for future adapters.
    }
  }
}

export function createDaemonOperationalMetrics(
  metrics: DaemonMetrics,
  options?: DaemonOperationalMetricsOptions
): DaemonOperationalMetrics {
  return metrics.enabled
    ? new ActiveDaemonOperationalMetrics(metrics, options)
    : NOOP_DAEMON_OPERATIONAL_METRICS;
}

function isDaemonOperationalMetrics(candidate: unknown): candidate is DaemonOperationalMetrics {
  if (!candidate || typeof candidate !== 'object') return false;
  const operational = candidate as Partial<DaemonOperationalMetrics>;
  return (
    typeof operational.enabled === 'boolean' &&
    typeof operational.start === 'function' &&
    typeof operational.stop === 'function' &&
    typeof operational.beginExternalRequest === 'function' &&
    typeof operational.recordSocketClientConnection === 'function' &&
    typeof operational.recordSocketAuthenticationFailure === 'function'
  );
}

/** Resolve the application-owned passive state without a process singleton. */
export function getDaemonOperationalMetrics(
  owner: object | null | undefined
): DaemonOperationalMetrics {
  try {
    const operational = (
      owner as {
        get?: (name: 'daemonOperationalMetrics') => unknown;
      } | null
    )?.get?.('daemonOperationalMetrics');
    if (isDaemonOperationalMetrics(operational)) return operational;
  } catch {
    // Test doubles and partially constructed apps may reject unknown settings.
  }
  return NOOP_DAEMON_OPERATIONAL_METRICS;
}
