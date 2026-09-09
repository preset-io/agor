import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../client';
import * as encryption from '../encryption';
import { gatewayChannels } from '../schema';
import { GatewayChannelRepository } from './gateway-channels';

const query = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  selects: 0,
  projection: undefined as unknown,
}));
vi.mock('../database-wrapper', async (importOriginal) => {
  const original = await importOriginal<typeof import('../database-wrapper')>();
  return {
    ...original,
    select: (_db: unknown, projection: unknown) => {
      query.projection = projection;
      query.selects++;
      const result = {
        all: async () => query.rows,
        one: async () => query.rows[0],
        orderBy: () => result,
        limit: () => result,
      };
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
  it('display list and detail redact without any KDF and retain tenant identity', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    query.rows = [row(id)];
    const open = vi.spyOn(encryption, 'decryptApiKeyAsync');
    const repo = new GatewayChannelRepository({} as Database);
    const [display] = await repo.findDisplayAll();
    expect(display).toMatchObject({
      config: { bot_token: '••••••••', app_token: '••••••••', label: 'public' },
      agentic_config: { envVars: [{ key: 'API_KEY', value: '••••••••' }] },
      channel_key: '••••••••',
    });
    expect(Object.getOwnPropertyDescriptor(display, 'tenant_id')).toMatchObject({
      value: 'tenant-a',
      enumerable: false,
    });
    expect(await repo.findDisplayById(id)).toEqual(display);
    expect(open).not.toHaveBeenCalled();
    expect((await repo.findById(id))?.config.bot_token).toBe('bot');
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('display normalizes legacy env maps and never exposes unreadable stored material', async () => {
    query.rows = [
      {
        ...row(),
        config: { bot_token: 'invalid-ciphertext' },
        agentic_config: { envVars: { LEGACY: 'invalid-ciphertext' } },
      },
    ];
    const open = vi.spyOn(encryption, 'decryptApiKeyAsync');
    const [display] = await new GatewayChannelRepository({} as Database).findDisplayAll();
    expect(display.agentic_config?.envVars).toEqual([{ key: 'LEGACY', value: '••••••••' }]);
    expect(JSON.stringify(display)).not.toContain('invalid-ciphertext');
    expect(open).not.toHaveBeenCalled();
  });

  it('discovers IDs with one narrow query and no credential decryption', async () => {
    const first = '00000000-0000-4000-8000-000000000001';
    query.rows = [row(first), row('second')];
    const open = vi.spyOn(encryption, 'decryptApiKeyAsync');
    const repo = new GatewayChannelRepository({} as Database);
    expect(await repo.findEnabledListenerCandidateIds(2)).toEqual([first, 'second']);
    expect(query.projection).toEqual({ id: gatewayChannels.id });
    expect(query.selects).toBe(1);
    expect(open).not.toHaveBeenCalled();
    // Discovery is not a credential cache: the later authoritative read opens
    // the current row, including all three secret fields.
    await repo.findById(first);
    expect(open).toHaveBeenCalledTimes(3);
  });

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

  it.skipIf(process.env.AGOR_BENCH_GATEWAY_DISCOVERY !== '1')(
    'benchmarks discovery hydration versus ID projection with real crypto',
    async () => {
      query.rows = Array.from({ length: 6 }, (_, i) => row(String(i)));
      const repo = new GatewayChannelRepository({} as Database);
      const samples: Record<string, number[]> = { hydrated: [], ids: [] };
      for (let round = 0; round < 4; round++) {
        for (const mode of round % 2 ? ['ids', 'hydrated'] : ['hydrated', 'ids']) {
          const start = performance.now();
          const result =
            mode === 'ids'
              ? await repo.findEnabledListenerCandidateIds(6)
              : (await repo.findAll()).map((channel) => channel.id);
          expect(result).toEqual(['0', '1', '2', '3', '4', '5']);
          if (round) samples[mode].push(performance.now() - start);
        }
      }
      process.stdout.write(
        `Discovery-only benchmark, mock SQL / real crypto, ms: ${JSON.stringify(samples)}\n`
      );
    },
    30000
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
