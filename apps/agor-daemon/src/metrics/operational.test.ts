import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_METRICS } from './noop.js';
import {
  ActiveDaemonOperationalMetrics,
  createDaemonOperationalMetrics,
  DAEMON_OPERATIONAL_METRICS_INTERVAL_MS,
  NOOP_DAEMON_OPERATIONAL_METRICS,
} from './operational.js';
import type { DaemonMetrics, MetricTags } from './types.js';

class RecordingMetrics implements DaemonMetrics {
  readonly enabled = true;
  readonly calls: Array<{ type: string; name: string; value: number; tags?: MetricTags }> = [];

  increment(name: string, value = 1, tags?: MetricTags): void {
    this.calls.push({ type: 'increment', name, value, tags });
  }
  decrement(): void {}
  gauge(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ type: 'gauge', name, value, tags });
  }
  histogram(): void {}
  timing(): void {}
  distribution(): void {}
  startTimer(): () => number {
    return () => 0;
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function latestGauge(metrics: RecordingMetrics, name: string, transport?: string) {
  return metrics.calls.findLast(
    (call) => call.type === 'gauge' && call.name === name && call.tags?.transport === transport
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('daemon operational metrics', () => {
  it('keeps disabled metrics allocation-free and timer-free', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const createHistogram = vi.fn();
    const operational = createDaemonOperationalMetrics(NOOP_METRICS, {
      createEventLoopDelayHistogram: createHistogram,
    });

    expect(operational).toBe(NOOP_DAEMON_OPERATIONAL_METRICS);
    operational.start();
    operational.beginExternalRequest('http')();
    operational.recordSocketClientConnection()('transport close');
    expect(createHistogram).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('emits idle zeros and exact process-local active gauges every 15 seconds', () => {
    vi.useFakeTimers();
    const metrics = new RecordingMetrics();
    const histogram = {
      count: 0,
      max: 0,
      enable: vi.fn(),
      disable: vi.fn(),
      percentile: vi.fn(() => 0),
      reset: vi.fn(),
    };
    const operational = new ActiveDaemonOperationalMetrics(metrics, {
      createEventLoopDelayHistogram: () => histogram,
    });

    operational.start();
    expect(latestGauge(metrics, 'socketio.clients.active')?.value).toBe(0);
    expect(latestGauge(metrics, 'external_requests.in_flight', 'http')?.value).toBe(0);
    expect(latestGauge(metrics, 'external_requests.in_flight', 'socketio')?.value).toBe(0);

    const finishHttp = operational.beginExternalRequest('http');
    const finishSocket = operational.beginExternalRequest('socketio');
    const disconnect = operational.recordSocketClientConnection();
    vi.advanceTimersByTime(DAEMON_OPERATIONAL_METRICS_INTERVAL_MS);

    expect(latestGauge(metrics, 'socketio.clients.active')?.value).toBe(1);
    expect(latestGauge(metrics, 'external_requests.in_flight', 'http')?.value).toBe(1);
    expect(latestGauge(metrics, 'external_requests.in_flight', 'socketio')?.value).toBe(1);

    finishHttp();
    finishSocket();
    disconnect('client namespace disconnect');
    vi.advanceTimersByTime(DAEMON_OPERATIONAL_METRICS_INTERVAL_MS);
    expect(latestGauge(metrics, 'socketio.clients.active')?.value).toBe(0);
    expect(latestGauge(metrics, 'external_requests.in_flight', 'http')?.value).toBe(0);
    expect(latestGauge(metrics, 'external_requests.in_flight', 'socketio')?.value).toBe(0);

    operational.stop();
  });

  it('records bounded lifecycle rates once and never lets gauges go negative', () => {
    vi.useFakeTimers();
    const metrics = new RecordingMetrics();
    const operational = new ActiveDaemonOperationalMetrics(metrics, {
      createEventLoopDelayHistogram: () => ({
        count: 0,
        max: 0,
        enable: vi.fn(),
        disable: vi.fn(),
        percentile: vi.fn(() => 0),
        reset: vi.fn(),
      }),
    });
    operational.start();

    const finish = operational.beginExternalRequest('http');
    finish();
    finish();
    const disconnect = operational.recordSocketClientConnection();
    disconnect('private caller supplied reason');
    disconnect('transport error');
    operational.recordSocketAuthenticationFailure();
    vi.advanceTimersByTime(DAEMON_OPERATIONAL_METRICS_INTERVAL_MS);

    expect(
      metrics.calls.filter((call) => call.name === 'socketio.client.connections')
    ).toHaveLength(1);
    expect(metrics.calls.filter((call) => call.name === 'socketio.client.disconnections')).toEqual([
      expect.objectContaining({ value: 1, tags: { disconnect_reason: 'other' } }),
    ]);
    expect(
      metrics.calls.filter((call) => call.name === 'socketio.authentication_failures')
    ).toHaveLength(1);
    expect(
      metrics.calls.filter((call) => call.type === 'gauge').every((call) => call.value >= 0)
    ).toBe(true);
    operational.stop();
  });

  it('exports interval event-loop percentiles in milliseconds and resets the histogram', () => {
    vi.useFakeTimers();
    const metrics = new RecordingMetrics();
    const percentile = vi.fn((value: number) => {
      if (value === 50) return 1_000_000;
      if (value === 90) return 2_500_000;
      return 4_000_000;
    });
    const histogram = {
      count: 12,
      max: 9_000_000,
      enable: vi.fn(),
      disable: vi.fn(),
      percentile,
      reset: vi.fn(),
    };
    const operational = new ActiveDaemonOperationalMetrics(metrics, {
      createEventLoopDelayHistogram: () => histogram,
    });
    operational.start();

    vi.advanceTimersByTime(DAEMON_OPERATIONAL_METRICS_INTERVAL_MS);
    expect(
      metrics.calls
        .filter((call) => call.name.startsWith('node.event_loop.delay.'))
        .map((call) => [call.name, call.value])
    ).toEqual([
      ['node.event_loop.delay.p50_ms', 1],
      ['node.event_loop.delay.p90_ms', 2.5],
      ['node.event_loop.delay.p99_ms', 4],
      ['node.event_loop.delay.max_ms', 9],
    ]);
    expect(histogram.reset).toHaveBeenCalledOnce();

    operational.stop();
    expect(histogram.disable).toHaveBeenCalledOnce();
    expect(histogram.reset).toHaveBeenCalledTimes(2);
  });

  it('unrefs and disposes the sampler and isolates exporter failures', () => {
    const metrics = new RecordingMetrics();
    metrics.gauge = () => {
      throw new Error('exporter failed');
    };
    metrics.increment = () => {
      throw new Error('exporter failed');
    };
    const histogram = {
      count: 1,
      max: 1_000_000,
      enable: vi.fn(),
      disable: vi.fn(),
      percentile: vi.fn(() => 1_000_000),
      reset: vi.fn(),
    };
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const operational = new ActiveDaemonOperationalMetrics(metrics, {
      intervalMs: 60_000,
      createEventLoopDelayHistogram: () => histogram,
    });

    expect(() => operational.start()).not.toThrow();
    const timer = setIntervalSpy.mock.results[0]?.value;
    expect(timer?.hasRef?.()).toBe(false);
    expect(() => operational.recordSocketAuthenticationFailure()).not.toThrow();
    expect(() => operational.recordSocketClientConnection()('transport error')).not.toThrow();
    expect(() => operational.stop()).not.toThrow();
    expect(histogram.reset).toHaveBeenCalledOnce();
    expect(histogram.disable).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });
});
