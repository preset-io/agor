import { afterEach, beforeAll, describe, expect, vi } from 'vitest';
import { TENANT_AGENTIC_TOOL_NAMES } from '../../types';
import * as wrapper from '../database-wrapper';
import * as encryption from '../encryption';
import { dbTest } from '../test-helpers';
import { AppVariableRepository } from './app-variables';
import { TenantAgenticToolSettingsRepository } from './tenant-agentic-tools';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'tenant-agentic-tools-test-secret';
});

afterEach(() => vi.restoreAllMocks());

describe('TenantAgenticToolSettingsRepository', () => {
  dbTest('infers enabled=true without materializing a row', async ({ db }) => {
    const repository = new TenantAgenticToolSettingsRepository(db);
    await expect(repository.find('codex')).resolves.toEqual({});
    await expect(repository.isEnabled('codex')).resolves.toBe(true);
  });

  dbTest('stores enabled and provider connection atomically', async ({ db }) => {
    const repository = new TenantAgenticToolSettingsRepository(db);
    await repository.patch('codex', {
      enabled: false,
      connection: {
        OPENAI_API_KEY: 'workspace-key',
        OPENAI_BASE_URL: 'https://example.invalid/v1',
      },
    });

    await expect(repository.find('codex')).resolves.toEqual({
      revision: 1,
      enabled: false,
      connection: {
        OPENAI_API_KEY: 'workspace-key',
        OPENAI_BASE_URL: 'https://example.invalid/v1',
      },
    });
  });

  dbTest('explicit null clears a secret without changing other fields', async ({ db }) => {
    const repository = new TenantAgenticToolSettingsRepository(db);
    await repository.patch('claude-code', {
      connection: {
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_BASE_URL: 'https://example.invalid',
      },
    });
    await repository.patch('claude-code', {
      connection: { ANTHROPIC_API_KEY: null },
    });

    await expect(repository.find('claude-code')).resolves.toEqual({
      revision: 2,
      connection: { ANTHROPIC_BASE_URL: 'https://example.invalid' },
    });
  });

  dbTest(
    'stores non-default resolution policy without deleting dormant credentials',
    async ({ db }) => {
      const repository = new TenantAgenticToolSettingsRepository(db);
      await repository.patch('codex', {
        connection: { OPENAI_API_KEY: 'workspace-key' },
        resolution_policy: 'user_required',
      });
      await expect(repository.find('codex')).resolves.toEqual({
        revision: 1,
        resolution_policy: 'user_required',
        connection: { OPENAI_API_KEY: 'workspace-key' },
      });

      await repository.patch('codex', { resolution_policy: 'tenant_required' });
      await expect(repository.find('codex')).resolves.toEqual({
        revision: 2,
        resolution_policy: 'tenant_required',
        connection: { OPENAI_API_KEY: 'workspace-key' },
      });
    }
  );

  dbTest('increments a durable revision for same-presence credential rotations', async ({ db }) => {
    const repository = new TenantAgenticToolSettingsRepository(db);
    await repository.patch('claude-code', {
      connection: { ANTHROPIC_AUTH_TOKEN: 'synthetic-token-one' },
    });
    const first = await repository.find('claude-code');

    await repository.patch('claude-code', {
      connection: { ANTHROPIC_AUTH_TOKEN: 'synthetic-token-two' },
    });
    const second = await repository.find('claude-code');

    expect(first).toMatchObject({ revision: 1 });
    expect(second).toMatchObject({ revision: 2 });
    expect(Object.keys(first.connection ?? {})).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    expect(Object.keys(second.connection ?? {})).toEqual(['ANTHROPIC_AUTH_TOKEN']);
  });
  dbTest(
    'batches exactly the supported tools in one select, preserving defaults and fresh values',
    async ({ db }) => {
      const repository = new TenantAgenticToolSettingsRepository(db);
      const variables = new AppVariableRepository(db);
      await repository.patch('codex', {
        enabled: false,
        connection: { OPENAI_API_KEY: 'synthetic' },
      });
      // Unknown keys and other namespaces must not be opened or parsed.
      await variables.set({ namespace: 'agentic_tools', key: 'unknown', value: 'invalid-json' });
      await variables.set({ namespace: 'other', key: 'codex', value: 'invalid-json' });
      const expected = await Promise.all(
        TENANT_AGENTIC_TOOL_NAMES.map(async (tool) => [tool, await repository.find(tool)] as const)
      );
      const select = vi.spyOn(wrapper, 'select');
      expect(await repository.findAll()).toEqual(new Map(expected));
      expect(select).toHaveBeenCalledTimes(1);
      await variables.delete('agentic_tools', 'codex');
      expect((await repository.findAll()).get('codex')).toEqual({});
      await repository.patch('codex', { connection: { OPENAI_API_KEY: 'rotated' } });
      expect((await repository.findAll()).get('codex')?.connection?.OPENAI_API_KEY).toBe('rotated');
    }
  );

  dbTest('batch reads retain validation and wrapped decryption errors', async ({ db }) => {
    const repository = new TenantAgenticToolSettingsRepository(db);
    const variables = new AppVariableRepository(db);
    await variables.set({ namespace: 'agentic_tools', key: 'codex', value: '{"enabled":"no"}' });
    await expect(repository.findAll()).rejects.toThrow('Invalid enabled value');
    await variables.setEncrypted('agentic_tools', 'codex', '{}');
    vi.stubEnv('AGOR_MASTER_SECRET', 'wrong-master');
    try {
      await expect(repository.findAll()).rejects.toThrow(
        'Failed to decrypt app variable agentic_tools.codex: Secret decryption failed'
      );
      await expect(repository.find('codex')).rejects.toThrow(
        'Failed to decrypt app variable agentic_tools.codex: Secret decryption failed'
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  dbTest(
    'batch plaintext decoding is serial and preserves missing, empty and null values',
    async ({ db }) => {
      const variables = new AppVariableRepository(db);
      await variables.setEncrypted('batch-test', 'first', 'one');
      await variables.setEncrypted('batch-test', 'second', 'two');
      await variables.setEncrypted('batch-test', 'empty', '');
      await variables.setEncrypted('batch-test', 'null', null);
      let active = 0;
      let peak = 0;
      const native = encryption.decryptApiKeyAsync;
      const open = vi
        .spyOn(encryption, 'decryptApiKeyAsync')
        .mockImplementation(async (...args) => {
          peak = Math.max(peak, ++active);
          try {
            return await native(...args);
          } finally {
            active--;
          }
        });
      const select = vi.spyOn(wrapper, 'select');
      expect(await variables.getPlainMany('batch-test', [])).toEqual(new Map());
      expect(select).not.toHaveBeenCalled();
      expect(
        await variables.getPlainMany('batch-test', [
          'second',
          'missing',
          'first',
          'empty',
          'null',
          'second',
        ])
      ).toEqual(
        new Map([
          ['second', 'two'],
          ['missing', null],
          ['first', 'one'],
          ['empty', ''],
          ['null', null],
        ])
      );
      expect(select).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(3);
      expect(peak).toBe(1);
    }
  );

  dbTest.skipIf(process.env.AGOR_BENCH_SETTINGS_READ !== '1')(
    'benchmarks default settings inventory query overhead',
    async ({ db }) => {
      const repository = new TenantAgenticToolSettingsRepository(db);
      const samples: Record<string, number[]> = { individual: [], batch: [] };
      for (let round = 0; round < 101; round++) {
        for (const mode of round % 2 ? ['batch', 'individual'] : ['individual', 'batch']) {
          const start = performance.now();
          if (mode === 'individual')
            await Promise.all(TENANT_AGENTIC_TOOL_NAMES.map((tool) => repository.find(tool)));
          else await repository.findAll();
          if (round) samples[mode].push(performance.now() - start);
        }
      }
      const median = (values: number[]) =>
        values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      process.stdout.write(
        `Settings inventory SQLite (1 warmup, 100 alternating samples): ${JSON.stringify({ individualMedianMs: median(samples.individual), batchMedianMs: median(samples.batch), individualSelects: TENANT_AGENTIC_TOOL_NAMES.length, batchSelects: 1 })}\n`
      );
    }
  );
});
