import { UsersRepository } from '@agor/core/db';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as encryption from '../../../../packages/core/src/db/encryption';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('UsersService credential reader delegation', () => {
  dbTest.skipIf(process.env.AGOR_BENCH_PUBLIC_VALUES !== '1')(
    'benchmarks owner DTO decryption responsiveness',
    async ({ db }) => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-public-benchmark-key');
      const repository = new UsersRepository(db);
      const service = new UsersService(db);
      const user = await repository.create({ email: 'benchmark@example.invalid' });
      await repository.setToolConfigField(
        user.user_id,
        'codex',
        'OPENAI_BASE_URL',
        'https://codex.invalid'
      );
      await repository.setToolConfigField(
        user.user_id,
        'claude-code',
        'ANTHROPIC_BASE_URL',
        'https://claude.invalid'
      );
      const samples = [];
      for (let round = 0; round < 8; round++) {
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
          const result = await service.get(user.user_id, { user } as AuthenticatedParams);
          const elapsedMs = performance.now() - start;
          tick();
          expect(result.agentic_tools_public_values?.codex?.OPENAI_BASE_URL).toBe(
            'https://codex.invalid'
          );
          if (round) samples.push({ elapsedMs, maxTickGapMs });
        } finally {
          clearInterval(timer);
        }
      }
      process.stdout.write(`Owner DTO real SQLite + 2 public fields: ${JSON.stringify(samples)}\n`);
    }
  );

  dbTest(
    'self-only public values use async decryption without leaking to other readers',
    async ({ db }) => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-public-values-key');
      const repository = new UsersRepository(db);
      const service = new UsersService(db);
      const own = await repository.create({ email: 'public-own@example.invalid' });
      const other = await repository.create({ email: 'public-other@example.invalid' });
      await repository.setToolConfigField(own.user_id, 'codex', 'OPENAI_API_KEY', 'private-key');
      await repository.setToolConfigField(
        own.user_id,
        'codex',
        'OPENAI_BASE_URL',
        'https://private-host.invalid'
      );
      const sync = vi.spyOn(encryption, 'decryptApiKey');
      const open = vi.spyOn(encryption, 'decryptApiKeyAsync');
      const params = { user: own } as AuthenticatedParams;
      expect((await service.get(own.user_id, params)).agentic_tools_public_values).toEqual({
        codex: { OPENAI_BASE_URL: 'https://private-host.invalid' },
      });
      expect(open).toHaveBeenCalledTimes(1);
      expect(sync).not.toHaveBeenCalled();
      open.mockClear();
      const patched = await service.patch(own.user_id, { preferences: { theme: 'dark' } }, params);
      expect(patched.agentic_tools_public_values).toEqual({
        codex: { OPENAI_BASE_URL: 'https://private-host.invalid' },
      });
      expect(open).toHaveBeenCalledTimes(1); // Final DTO only, not the internal merge input.
      open.mockClear();
      expect(
        (await service.get(own.user_id, { user: other } as AuthenticatedParams))
          .agentic_tools_public_values
      ).toBeUndefined();
      expect((await service.get(own.user_id)).agentic_tools_public_values).toBeUndefined();
      expect(open).not.toHaveBeenCalled();
      vi.stubEnv('AGOR_MASTER_SECRET', 'wrong-public-values-key');
      expect((await service.get(own.user_id, params)).agentic_tools_public_values).toBeUndefined();
      expect(sync).not.toHaveBeenCalled();
    }
  );

  dbTest(
    'preserves values, user/tool isolation, and missing/corrupt result contracts',
    async ({ db }) => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-delegation-key');
      const repository = new UsersRepository(db);
      const service = new UsersService(db);
      const own = await repository.create({ email: 'own@example.invalid' });
      const other = await repository.create({ email: 'other@example.invalid' });
      await repository.setToolConfigField(own.user_id, 'codex', 'OPENAI_API_KEY', 'synthetic-key');
      await repository.setToolConfigField(
        own.user_id,
        'codex',
        'OPENAI_BASE_URL',
        'https://example.invalid'
      );
      const field = vi.spyOn(UsersRepository.prototype, 'getToolConfigField');
      const bag = vi.spyOn(UsersRepository.prototype, 'getToolConfig');
      expect(await service.getToolConfigField(own.user_id, 'codex', 'OPENAI_API_KEY')).toBe(
        'synthetic-key'
      );
      expect(field).toHaveBeenCalledWith(own.user_id, 'codex', 'OPENAI_API_KEY');
      expect(await service.getToolConfig(own.user_id, 'codex')).toEqual({
        OPENAI_API_KEY: 'synthetic-key',
        OPENAI_BASE_URL: 'https://example.invalid',
      });
      expect(bag).toHaveBeenCalledWith(own.user_id, 'codex');
      expect(
        await service.getToolConfigField(other.user_id, 'codex', 'OPENAI_API_KEY')
      ).toBeUndefined();
      expect(await service.getToolConfig(other.user_id, 'codex')).toBeNull();
      expect(await service.getToolConfig(own.user_id, 'claude-code')).toBeNull();
      vi.stubEnv('AGOR_MASTER_SECRET', 'wrong-key');
      const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(
        await service.getToolConfigField(own.user_id, 'codex', 'OPENAI_API_KEY')
      ).toBeUndefined();
      expect(await service.getToolConfig(own.user_id, 'codex')).toBeNull();
      expect(logs).toHaveBeenCalledTimes(3);
    }
  );

  it('does not turn storage errors into missing credentials', async () => {
    const error = new Error('synthetic storage failure');
    vi.spyOn(UsersRepository.prototype, 'getToolConfigField').mockRejectedValue(error);
    vi.spyOn(UsersRepository.prototype, 'getToolConfig').mockRejectedValue(error);
    const service = new UsersService({} as ConstructorParameters<typeof UsersService>[0]);
    const user = '00000000-0000-7000-8000-000000000001' as UserID;
    await expect(service.getToolConfigField(user, 'codex', 'OPENAI_API_KEY')).rejects.toBe(error);
    await expect(service.getToolConfig(user, 'codex')).rejects.toBe(error);
  });
});
