import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../client';
import * as encryption from '../encryption';
import { GatewayChannelRepository } from './gateway-channels';

const query = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], selects: 0 }));
vi.mock('../database-wrapper', async (importOriginal) => {
  const original = await importOriginal<typeof import('../database-wrapper')>();
  return {
    ...original,
    select: () => {
      query.selects++;
      const result = { all: async () => query.rows, one: async () => query.rows[0] };
      return { from: () => ({ ...result, where: () => result }) };
    },
  };
});

function row(id = 'synthetic-channel') {
  return {
    id,
    tenant_id: 'tenant-a',
    name: id,
    channel_type: 'slack',
    enabled: true,
    config: {
      bot_token: encryption.encryptApiKey('bot'),
      app_token: encryption.encryptApiKey('app'),
      label: 'public',
    },
    agentic_config: {
      envVars: [{ key: 'API_KEY', value: encryption.encryptApiKey('env'), isSecret: true }],
    },
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
  };
}

beforeEach(() => {
  vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-gateway-master');
  query.rows = [];
  query.selects = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('gateway credential hydration', () => {
  it('opens rows and fields serially, preserves order and hidden tenant, and does not cache', async () => {
    query.rows = [row('second'), row('first')];
    let active = 0;
    let peak = 0;
    const native = encryption.decryptApiKeyAsync;
    const open = vi.spyOn(encryption, 'decryptApiKeyAsync').mockImplementation(async (...args) => {
      peak = Math.max(peak, ++active);
      await nextTurn();
      try {
        return await native(...args);
      } finally {
        active--;
      }
    });
    const repo = new GatewayChannelRepository({} as Database);
    const channels = await repo.findAll();
    expect(channels.map((channel) => channel.id)).toEqual(['second', 'first']);
    expect(channels[0]).toMatchObject({
      config: { bot_token: 'bot', app_token: 'app', label: 'public' },
      agentic_config: { envVars: [{ value: 'env', isSecret: true }] },
    });
    expect(Object.getOwnPropertyDescriptor(channels[0], 'tenant_id')).toMatchObject({
      value: 'tenant-a',
      enumerable: false,
    });
    expect(peak).toBe(1);
    expect(open).toHaveBeenCalledTimes(6);
    expect(query.selects).toBe(1);
    query.rows = [];
    await expect(repo.findAll()).resolves.toEqual([]);
    expect(query.selects).toBe(2);
  });

  it.each(['array', 'legacy'])(
    'preserves fail-closed omissions for corrupt credentials and %s env vars',
    async (shape) => {
      const fixture = row();
      query.rows = [
        {
          ...fixture,
          config: { ...fixture.config, bot_token: 'corrupt' },
          agentic_config: {
            envVars:
              shape === 'array'
                ? [
                    { key: 'GOOD', value: encryption.encryptApiKey('good') },
                    { key: 'BAD', value: 'corrupt' },
                    { key: 'EMPTY', value: '' },
                  ]
                : {
                    GOOD: encryption.encryptApiKey('good'),
                    BAD: 'corrupt',
                    EMPTY: '',
                    OTHER: null,
                  },
          },
        },
      ];
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
      const [channel] = await new GatewayChannelRepository({} as Database).findAll();
      expect(channel.config).toEqual({ app_token: 'app', label: 'public' });
      expect(channel.agentic_config?.envVars).toEqual(
        shape === 'array'
          ? [
              { key: 'GOOD', value: 'good' },
              { key: 'EMPTY', value: '' },
            ]
          : { GOOD: 'good', EMPTY: '', OTHER: null }
      );
      expect(logs).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(logs.mock.calls)).not.toContain('corrupt:');
    }
  );

  it.skipIf(process.env.AGOR_BENCH_GATEWAY_READ !== '1')(
    'benchmarks six channels with three credentials each',
    async () => {
      query.rows = Array.from({ length: 6 }, (_, i) => row(String(i)));
      const native = encryption.decryptApiKeyAsync;
      const repo = new GatewayChannelRepository({} as Database);
      const samples: Record<string, { elapsedMs: number; maxTickGapMs: number }[]> = {
        sync: [],
        async: [],
      };
      for (let round = 0; round < 4; round++) {
        for (const mode of round % 2 ? ['async', 'sync'] : ['sync', 'async']) {
          const spy = vi
            .spyOn(encryption, 'decryptApiKeyAsync')
            .mockImplementation(
              mode === 'sync' ? async (...args) => encryption.decryptApiKey(...args) : native
            );
          let last = performance.now();
          let maxTickGapMs = 0;
          const tick = () => {
            const now = performance.now();
            maxTickGapMs = Math.max(maxTickGapMs, now - last);
            last = now;
          };
          const timer = setInterval(tick, 5);
          try {
            const start = performance.now();
            expect(await repo.findAll()).toHaveLength(6);
            const elapsedMs = performance.now() - start;
            await nextTurn();
            tick();
            if (round) samples[mode].push({ elapsedMs, maxTickGapMs });
          } finally {
            clearInterval(timer);
            spy.mockRestore();
          }
        }
      }
      process.stdout.write(
        `Gateway hydration benchmark (1 warmup, 3 samples): ${JSON.stringify(samples)}\n`
      );
    },
    30000
  );
});
