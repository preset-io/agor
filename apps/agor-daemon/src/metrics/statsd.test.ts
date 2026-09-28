import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import type { DistributedWorkIdentity } from '@agor/core/coordination';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStatsDClientOptions,
  createDaemonMetrics,
  getDaemonMetrics,
  NOOP_METRICS,
  resolveMetricsWorkIdentity,
  StatsDDaemonMetrics,
  sanitizeMetricTags,
} from './index.js';
import type { StatsDMetricOptions, StatsDTransportClient } from './statsd.js';

class FakeStatsDClient implements StatsDTransportClient {
  calls: Array<{ method: string; name?: string; value?: number; options?: StatsDMetricOptions }> =
    [];
  closeCalls = 0;

  increment(name: string, value: number, options?: StatsDMetricOptions): void {
    this.calls.push({ method: 'increment', name, value, options });
  }
  timing(name: string, value: number, options?: StatsDMetricOptions): void {
    this.calls.push({ method: 'timing', name, value, options });
  }
  histogram(name: string, value: number, options?: StatsDMetricOptions): void {
    this.calls.push({ method: 'histogram', name, value, options });
  }
  distribution(name: string, value: number, options?: StatsDMetricOptions): void {
    this.calls.push({ method: 'distribution', name, value, options });
  }
  gauge(name: string, value: number, options?: StatsDMetricOptions): void {
    this.calls.push({ method: 'gauge', name, value, options });
  }
  flush(callback?: (error?: Error) => void): void {
    this.calls.push({ method: 'flush' });
    callback?.();
  }
  close(callback?: (error?: Error) => void): void {
    this.closeCalls += 1;
    this.calls.push({ method: 'close' });
    callback?.();
  }
}

const workIdentity: DistributedWorkIdentity = { instanceId: 'daemon-a', bootId: 'boot-1' };
const deploymentId = '019c1234-5678-7123-8123-123456789abc';

describe('StatsD daemon metrics', () => {
  it('sends sanitized metrics through the real optional hot-shots UDP client', async () => {
    const receiver = createSocket('udp4');
    receiver.bind(0, '127.0.0.1');
    await once(receiver, 'listening');
    const metrics = createDaemonMetrics(
      { enabled: true, host: '127.0.0.1', port: receiver.address().port },
      { workIdentity, deploymentMode: 'standalone', deploymentId }
    );
    try {
      expect(metrics.enabled).toBe(true);
      const received = once(receiver, 'message', { signal: AbortSignal.timeout(2000) });
      metrics.increment('dependency_smoke', 2, { outcome: 'success', token: 'must-not-leak' });
      await metrics.flush();
      const [packet] = await received;
      const wire = packet.toString();
      expect(wire).toContain('agor.daemon.dependency_smoke:2|c');
      expect(wire).toContain('outcome:success');
      expect(wire).toContain(`deployment_id:${deploymentId}`);
      expect(wire).not.toContain('must-not-leak');
    } finally {
      await metrics.close();
      receiver.close();
    }
  });

  it('uses one cheap no-op and never constructs a client while disabled', async () => {
    const factory = vi.fn(() => new FakeStatsDClient());
    const metrics = createDaemonMetrics(
      { enabled: false },
      { workIdentity, deploymentMode: 'standalone', deploymentId },
      factory
    );
    expect(metrics).toBe(NOOP_METRICS);
    expect(factory).not.toHaveBeenCalled();
    expect(metrics.startTimer('anything')()).toBe(0);
    await expect(metrics.close()).resolves.toBeUndefined();
  });

  it('maps counters, gauges and latency types to the injected client', async () => {
    const client = new FakeStatsDClient();
    const metrics = new StatsDDaemonMetrics(client);
    metrics.increment('requests', 2, { method: 'GET' });
    metrics.decrement('in_flight', 3);
    metrics.gauge('executors.running', 4, { scope: 'process_group' });
    metrics.histogram('payload.size', 10);
    metrics.timing('local.timer', 11);
    metrics.distribution('request.duration_ms', 12, { status_code: 200 });
    const elapsed = metrics.startTimer('helper.duration_ms', { outcome: 'success' })();
    expect(elapsed).toBeGreaterThanOrEqual(0);

    expect(client.calls.map(({ method, name, value }) => ({ method, name, value }))).toEqual([
      { method: 'increment', name: 'requests', value: 2 },
      { method: 'increment', name: 'in_flight', value: -3 },
      { method: 'gauge', name: 'executors.running', value: 4 },
      { method: 'histogram', name: 'payload.size', value: 10 },
      { method: 'timing', name: 'local.timer', value: 11 },
      { method: 'distribution', name: 'request.duration_ms', value: 12 },
      { method: 'timing', name: 'helper.duration_ms', value: elapsed },
    ]);
    expect(client.calls[0]?.options).toEqual({ tags: { method: 'GET' }, cardinality: 'low' });

    await metrics.flush();
    await Promise.all([metrics.close(), metrics.close()]);
    expect(client.closeCalls).toBe(1);
    metrics.increment('after_close');
    expect(client.calls.some((call) => call.name === 'after_close')).toBe(false);
  });

  it('isolates synchronous transport, reporter, flush and close failures', async () => {
    const client = new FakeStatsDClient();
    client.increment = () => {
      throw new Error('socket failed');
    };
    client.flush = () => {
      throw new Error('flush failed');
    };
    client.close = (callback) => callback?.(new Error('close failed'));
    const reporter = vi.fn(() => {
      throw new Error('reporter failed');
    });
    const metrics = new StatsDDaemonMetrics(client, reporter, 10);
    expect(() => metrics.increment('safe')).not.toThrow();
    await expect(metrics.flush()).resolves.toBeUndefined();
    await expect(metrics.close()).resolves.toBeUndefined();
    expect(reporter).toHaveBeenCalledTimes(3);
  });

  it('enforces a low-cardinality runtime tag allow-list', () => {
    expect(
      sanitizeMetricTags({
        method: 'GET',
        outcome: 'success',
        disconnect_reason: 'transport_error',
        reason: 'caller-controlled',
        session_id: 'forbidden',
        tenant: 'forbidden',
        service: 'sessions',
        route: '/sessions/0198d20e-7182-7000-8000-000000000000',
      })
    ).toEqual({
      method: 'GET',
      outcome: 'success',
      disconnect_reason: 'transport_error',
      service: 'sessions',
    });
  });

  it('builds per-instance HA gauge dimensions without a boot-id series', () => {
    const optionsA = buildStatsDClientOptions(
      {
        enabled: true,
        // Effective config validation rejects this reserved key. The factory
        // still keeps canonical context authoritative if called directly.
        global_tags: { env: 'prod', deployment_id: 'cannot-override' },
      },
      { workIdentity, deploymentMode: 'ha', deploymentId },
      vi.fn()
    );
    const optionsB = buildStatsDClientOptions(
      { enabled: true, global_tags: { env: 'prod' } },
      {
        workIdentity: { instanceId: 'daemon-b', bootId: 'another-boot' },
        deploymentMode: 'ha',
        deploymentId,
      },
      vi.fn()
    );
    expect(optionsA.globalTags).toEqual({
      env: 'prod',
      deployment_id: deploymentId,
      daemon_instance: 'daemon-a',
      deployment_mode: 'ha',
    });
    expect(optionsB.globalTags).toMatchObject({ daemon_instance: 'daemon-b' });
    expect(JSON.stringify(optionsA.globalTags)).not.toContain('boot');
    expect(optionsA).toMatchObject({
      protocol: 'udp',
      datadog: true,
      includeDataDogTags: false,
      includeDatadogTelemetry: false,
      cardinality: 'low',
    });
  });

  it('uses a bounded standalone series and requires explicit HA identity', () => {
    expect(resolveMetricsWorkIdentity('standalone', workIdentity, undefined)).toEqual({
      instanceId: 'standalone',
      bootId: 'boot-1',
    });
    expect(resolveMetricsWorkIdentity('ha', workIdentity, undefined)).toBeUndefined();
    expect(resolveMetricsWorkIdentity('ha', workIdentity, 'not safe:value')).toBeUndefined();
    expect(resolveMetricsWorkIdentity('ha', workIdentity, ' stable-replica ')).toEqual({
      instanceId: 'stable-replica',
      bootId: 'boot-1',
    });
  });

  it('falls back to no-op if client construction fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      createDaemonMetrics(
        { enabled: true },
        { workIdentity, deploymentMode: 'standalone', deploymentId },
        () => {
          throw new Error('constructor failure');
        }
      )
    ).toBe(NOOP_METRICS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('constructor failure'));
    warn.mockRestore();
  });

  it('rejects partially shaped application metrics dependencies', () => {
    expect(getDaemonMetrics({ get: () => ({ increment: vi.fn() }) })).toBe(NOOP_METRICS);

    const metrics = new StatsDDaemonMetrics(new FakeStatsDClient());
    expect(getDaemonMetrics({ get: () => metrics })).toBe(metrics);
  });
});
