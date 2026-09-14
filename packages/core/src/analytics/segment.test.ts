import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenSourceTelemetryLogger } from '../telemetry/logger.js';
import { createHttpBatchAnalyticsPlugin, createStdoutAnalyticsPlugin } from './plugins.js';
import { SEGMENT_TRACK_EVENT_NAME } from './segment.js';

const timestamp = '2026-01-01T00:00:00.000Z';

describe('unified Segment Track boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('maps two queued operator events without mutating internal records or metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(timestamp);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const http = createHttpBatchAnalyticsPlugin({
      type: 'http_batch',
      enabled: true,
      options: { url: 'https://example.test/batch', max_batch_size: 10, flush_interval_ms: 100 },
    });
    const stdout = createStdoutAnalyticsPlugin({ type: 'stdout', enabled: true });
    const records = ['task.created', 'task.completed'].map((event) => ({
      event,
      properties: Object.freeze({
        event_type: 'caller-conflict',
        action: 'synthetic-action',
        event_id: 'synthetic-event-id',
        nested: { count: 2, tags: ['safe'] },
      }),
      options: { userId: 'user-1', anonymousId: 'anon-1', context: { tenant_id: 'tenant-a' } },
      meta: { ts: Date.parse(timestamp) },
    }));
    const snapshot = structuredClone(records);
    for (const record of records) {
      http?.track?.({ payload: record });
      stdout.track?.(record); // Both supported SDK wrapper and direct payload shapes.
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body).toEqual({
      sentAt: '2026-01-01T00:00:00.100Z',
      batch: records.map((record) => ({
        type: 'track',
        event: SEGMENT_TRACK_EVENT_NAME,
        properties: { ...record.properties, event_type: record.event },
        userId: 'user-1',
        anonymousId: 'anon-1',
        context: { tenant_id: 'tenant-a' },
        timestamp,
      })),
    });
    expect(body.batch.map((event: { event: string }) => event.event)).toEqual([
      'agor_event',
      'agor_event',
    ]);
    expect(log.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual(body.batch);
    expect(records).toEqual(snapshot);
    await http?.flush?.();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retains best-effort failure behavior without retries or duplicate events', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plugin = createHttpBatchAnalyticsPlugin({
      type: 'http_batch',
      enabled: true,
      options: { url: 'https://example.test/batch', max_batch_size: 10 },
    });
    plugin?.track?.({ event: 'task.completed' });
    await plugin?.flush?.();
    await vi.advanceTimersByTimeAsync(5000);
    await plugin?.flush?.();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).batch).toEqual([
      expect.objectContaining({
        event: 'agor_event',
        properties: { event_type: 'task.completed' },
      }),
    ]);
  });

  it('maps the alternate telemetry HTTP path after redaction, retaining anonymous identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(timestamp);
    vi.stubEnv('AGOR_TELEMETRY', '1');
    vi.stubEnv('DO_NOT_TRACK', undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    const logger = createOpenSourceTelemetryLogger({
      telemetry: {
        enabled: true,
        instance_id: 'install-1',
        endpoint: 'https://example.test/batch',
      },
    });
    const properties = Object.freeze({
      event_type: 'caller-conflict',
      action: 'synthetic-action',
      prompt: 'must-not-leave',
      nested: { count: 2, token: 'must-not-leave' },
    });
    for (const event of ['daemon.start', 'daemon.active'] as const) {
      logger.track({ event, properties, timestamp });
    }
    await logger.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      sentAt: timestamp,
      batch: ['daemon.start', 'daemon.active'].map((event_type) => ({
        type: 'track',
        event: 'agor_event',
        anonymousId: 'install-1',
        properties: { event_type, action: 'synthetic-action', nested: { count: 2 } },
        timestamp,
        context: { app: 'agor', telemetry: 'open-source' },
      })),
    });
    expect(properties.event_type).toBe('caller-conflict');
    expect(properties.nested.token).toBe('must-not-leave');
  });

  it.each(['DO_NOT_TRACK', 'AGOR_TELEMETRY'] as const)(
    'honors the %s telemetry kill switch',
    async (key) => {
      vi.stubEnv('AGOR_TELEMETRY', '1');
      vi.stubEnv('DO_NOT_TRACK', undefined);
      vi.stubEnv(key, key === 'DO_NOT_TRACK' ? '1' : '0');
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      const logger = createOpenSourceTelemetryLogger({
        telemetry: {
          enabled: true,
          instance_id: 'install-1',
          endpoint: 'https://example.test/batch',
        },
      });
      logger.track({ event: 'daemon.start', properties: {} });
      await logger.flush();
      expect(logger.isEnabled()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
