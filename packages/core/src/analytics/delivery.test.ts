import * as yaml from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertValidRawConfig } from '../config/config-manager.js';
import { buildAllowlistedEnv, createUserProcessEnvironment } from '../config/env-resolver.js';
import type { AgorAnalyticsSettings } from '../config/types.js';
import { runWithTenantContext } from '../db/tenant-context.js';
import {
  configureAnalyticsLogger,
  createAnalyticsLogger,
  resolveAnalyticsConfig,
} from './logger.js';

const SECRET = 'synthetic-test-only-authorization';
const ENV_NAME = 'AGOR_ANALYTICS_AUTHORIZATION';

function settings(environment = 'cloud'): AgorAnalyticsSettings {
  return {
    enabled: true,
    client: { app: `agor-${environment}-daemon`, version: 1, debug: true },
    extras: {
      environment,
      deployment: `${environment}-production-us1a`,
      replicas: 2,
      managed: true,
    },
    filters: { exclude_events: ['private.*'] },
    plugins: [
      {
        type: 'http_batch',
        enabled: true,
        options: {
          url: 'https://example.test/batch',
          max_batch_size: 1,
          headers: { 'x-source': 'agor' },
          headers_from_env: { Authorization: ENV_NAME },
        },
      },
      { type: 'stdout', enabled: true },
    ],
  };
}

describe('actual Analytics client delivery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('owns app/extras and tenant identity across environments while preserving caller data', async () => {
    vi.stubEnv(ENV_NAME, SECRET);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (const environment of ['cloud', 'sandbox']) {
      const config = settings(environment);
      const snapshot = JSON.stringify(config);
      assertValidRawConfig({ analytics: config });
      const logger = await createAnalyticsLogger(config);
      expect(JSON.stringify(config)).toBe(snapshot);
      const context = JSON.parse(
        '{"source":"caller","app":{"name":"spoof"},"extras":{"environment":"spoof"},"tenant_id":"foreign-tenant","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}'
      );
      runWithTenantContext(`tenant-${environment}`, () => {
        logger.track(
          'task.completed',
          { duration_ms: 123 },
          {
            userId: 'user-1',
            anonymousId: 'anon-1',
            context,
          }
        );
        logger.track('private.event');
      });
      logger.track('daemon.event', {}, { context });
      // Mutating input after initialization must not rewrite the operator snapshot.
      if (config.extras) config.extras.environment = 'mutated';
      if (config.client) config.client.app = 'mutated';
      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.length).toBe(environment === 'cloud' ? 2 : 4)
      );
      for (const [offset, tenant] of [
        [0, `tenant-${environment}`],
        [1, undefined],
      ] as const) {
        const index = (environment === 'cloud' ? 0 : 2) + offset;
        const [url, init] = fetchMock.mock.calls[index];
        expect(url).toBe('https://example.test/batch');
        expect(init?.headers).toMatchObject({ Authorization: SECRET, 'x-source': 'agor' });
        expect(init?.redirect).toBe('error');
        const event = JSON.parse(init?.body as string).batch[0];
        expect(event.context).toEqual({
          source: 'caller',
          app: { name: `agor-${environment}-daemon`, version: '1' },
          extras: {
            environment,
            deployment: `${environment}-production-us1a`,
            replicas: 2,
            managed: true,
          },
          ...(tenant ? { tenant_id: tenant } : {}),
        });
        if (tenant)
          expect(event).toMatchObject({
            userId: 'user-1',
            anonymousId: 'anon-1',
            properties: { duration_ms: 123 },
          });
        const stdoutEvents = log.mock.calls
          .flat()
          .filter((value): value is string => typeof value === 'string' && value.startsWith('{'))
          .map((value) => JSON.parse(value));
        expect(stdoutEvents).toContainEqual(event);
      }
      expect(snapshot).not.toContain(SECRET);
      expect(JSON.stringify(resolveAnalyticsConfig(config))).not.toContain(SECRET);
      expect(yaml.dump(config)).not.toContain(SECRET);
    }
    expect({}).not.toHaveProperty('polluted');
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    expect(buildAllowlistedEnv()).not.toHaveProperty(ENV_NAME);
    expect(await createUserProcessEnvironment()).not.toHaveProperty(ENV_NAME);
  });

  it('ignores inherited caller context, uses defaults, and leaves tenant absent outside scope', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = await createAnalyticsLogger({
      enabled: true,
      plugins: [
        {
          type: 'http_batch',
          enabled: true,
          options: { url: 'https://example.test', max_batch_size: 1 },
        },
      ],
    });
    logger.track(
      'legacy.event',
      {},
      {
        context: Object.create({
          tenant_id: 'foreign',
          source: 'inherited',
          app: { name: 'spoof' },
        }),
      }
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).batch[0].context).toEqual({
      app: { name: 'agor-daemon', version: 'dev' },
      extras: {},
    });
  });

  it.each([undefined, '', '   ', 'secret\r\ninjected: true', 'é', 'x'.repeat(8193)])(
    'fails closed with bounded safe errors for invalid env case %#',
    async (value) => {
      vi.stubEnv(ENV_NAME, value);
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const logger = await configureAnalyticsLogger(settings());
      expect(logger.isEnabled()).toBe(false);
      logger.track('event');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        '[analytics] failed to configure analytics; continuing with analytics disabled:',
        'Analytics http_batch header environment value is missing, empty, or invalid'
      );
    }
  );

  it('does not resolve missing credentials for disabled analytics or plugins', async () => {
    vi.stubEnv(ENV_NAME, undefined);
    expect((await createAnalyticsLogger({ ...settings(), enabled: false })).isEnabled()).toBe(
      false
    );
    const config = settings();
    for (const plugin of config.plugins ?? []) plugin.enabled = false;
    expect((await createAnalyticsLogger(config)).isEnabled()).toBe(true);
  });

  it('fails closed on a static/env header collision without sending or logging either value', async () => {
    vi.stubEnv(ENV_NAME, SECRET);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = settings();
    const plugin = config.plugins?.[0];
    if (plugin?.type !== 'http_batch' || !plugin.options) throw new Error('missing test plugin');
    plugin.options.headers = { authorization: 'synthetic-static-secret' };
    const logger = await configureAnalyticsLogger(config);
    expect(logger.isEnabled()).toBe(false);
    logger.track('event');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[analytics] failed to configure analytics; continuing with analytics disabled:',
      'Config error: invalid analytics header names (invalid or case-insensitive conflict)'
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-static-secret');
  });

  it('never logs credential-bearing fetch exceptions', async () => {
    vi.stubEnv(ENV_NAME, SECRET);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error(SECRET)));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = await createAnalyticsLogger(settings());
    logger.track('event');
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[analytics] http_batch delivery failed')
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });
});
