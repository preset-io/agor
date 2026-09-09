import { UsersRepository } from '@agor/core/db';
import type { UserID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('UsersService credential reader delegation', () => {
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
