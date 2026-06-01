import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultAnalyticsConfig } from '../config/analytics-defaults.js';
import { getDefaultConfig } from '../config/config-manager.js';
import type { AgorAnalyticsSettings } from '../config/types.js';
import { isAnalyticsEventExcluded } from './filters.js';
import {
  AnalyticsPackageLogger,
  configureAnalyticsLogger,
  createAnalyticsLogger,
} from './logger.js';
import {
  createHttpBatchAnalyticsPlugin,
  createStdoutAnalyticsPlugin,
  resolveAnalyticsPlugins,
} from './plugins.js';

const enabledBase: AgorAnalyticsSettings = {
  enabled: true,
  client: { app: 'test', version: 'dev', debug: false },
  filters: { exclude_events: [] },
  plugins: [],
};

describe('analytics config defaults', () => {
  it('is disabled by default', () => {
    expect(getDefaultAnalyticsConfig().enabled).toBe(false);
    expect(getDefaultConfig().analytics?.enabled).toBe(false);
  });
});

describe('analytics event exclusion', () => {
  it('matches exact event names and simple globs', () => {
    expect(isAnalyticsEventExcluded('task.created', ['task.created'])).toBe(true);
    expect(isAnalyticsEventExcluded('task.completed', ['task.*'])).toBe(true);
    expect(isAnalyticsEventExcluded('session.created', ['task.*'])).toBe(false);
  });
});

describe('analytics logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op when disabled', async () => {
    const logger = await createAnalyticsLogger({ enabled: false });
    expect(logger.isEnabled()).toBe(false);
    expect(() => logger.track('task.created', { task_id: 'task-1' })).not.toThrow();
  });

  it('resolves enabled stdout plugins', async () => {
    const plugins = await resolveAnalyticsPlugins({
      ...enabledBase,
      plugins: [{ type: 'stdout', enabled: true, options: { pretty: false } }],
    });

    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('agor-stdout-analytics');
  });

  it('does not deliver excluded events to plugins', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = await createAnalyticsLogger({
      ...enabledBase,
      filters: { exclude_events: ['task.*'] },
      plugins: [{ type: 'stdout', enabled: true, options: { pretty: false } }],
    });

    logger.track('task.created', { task_id: 'task-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(log).not.toHaveBeenCalled();
  });

  it('falls back to no-op when analytics configuration throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = await configureAnalyticsLogger({
      ...enabledBase,
      client: {
        get app(): string {
          throw new Error('bad client config');
        },
      },
    });

    expect(logger.isEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[analytics] failed to configure analytics; continuing with analytics disabled:',
      'bad client config'
    );
  });

  it('isolates synchronous analytics client track failures', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = new AnalyticsPackageLogger({
      track: () => {
        throw new Error('sync boom');
      },
    } as never);

    expect(() => logger.track('task.created', { task_id: 'task-1' })).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[analytics] track failed for "task.created":', 'sync boom');
  });
});

describe('analytics plugins', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stdout emits Segment-like track JSON', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const plugin = createStdoutAnalyticsPlugin({
      type: 'stdout',
      enabled: true,
      options: { pretty: false },
    });

    plugin.track?.({
      payload: {
        event: 'session.created',
        properties: { session_id: 'session-1' },
        options: { userId: 'user-1', context: { source: 'test' } },
        meta: { ts: Date.parse('2026-01-01T00:00:00.000Z') },
      },
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      type: 'track',
      event: 'session.created',
      userId: 'user-1',
      properties: { session_id: 'session-1' },
      context: { source: 'test' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('http_batch posts a Segment-like batch payload', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const plugin = createHttpBatchAnalyticsPlugin({
      type: 'http_batch',
      enabled: true,
      options: {
        url: 'https://example.test/collect',
        max_batch_size: 1,
        flush_interval_ms: 1000,
        timeout_ms: 1000,
        headers: { 'x-test': 'yes' },
      },
    });

    plugin?.track?.({
      payload: {
        event: 'task.completed',
        properties: { task_id: 'task-1', duration_ms: 123 },
        options: { userId: 'user-1' },
        meta: { ts: Date.parse('2026-01-01T00:00:00.000Z') },
      },
    });
    await plugin?.flush?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/collect');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-test': 'yes' });
    expect(JSON.parse(init.body as string)).toEqual({
      sentAt: expect.any(String),
      batch: [
        {
          type: 'track',
          event: 'task.completed',
          userId: 'user-1',
          properties: { task_id: 'task-1', duration_ms: 123 },
          context: {},
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('http_batch flushes events queued during an in-flight delivery', async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const plugin = createHttpBatchAnalyticsPlugin({
      type: 'http_batch',
      enabled: true,
      options: {
        url: 'https://example.test/collect',
        max_batch_size: 1,
        flush_interval_ms: 1000,
        timeout_ms: 1000,
      },
    });

    plugin?.track?.({ payload: { event: 'first' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    plugin?.track?.({ payload: { event: 'second' } });
    resolveFirst(new Response(null, { status: 200 }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(secondInit.body as string).batch).toEqual([
      expect.objectContaining({ event: 'second' }),
    ]);
  });

  it('skips relative module plugin paths to avoid cwd-dependent imports', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const plugins = await resolveAnalyticsPlugins({
      ...enabledBase,
      plugins: [
        {
          type: 'module',
          enabled: true,
          options: { module_path: './analytics-plugin.js' },
        },
      ],
    });

    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[analytics] module plugin options.module_path must be a package specifier or absolute path; skipping relative path'
    );
  });
});
