import type { UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

async function makeCaller(service: UsersService) {
  const user = await service.create({
    email: `primary-tool-${Math.random().toString(36).slice(2)}@test.local`,
    password: 'test-password-1234',
    role: 'member',
  });
  const params = { user: { user_id: user.user_id, role: 'member' } } as never;
  return { user, params };
}

describe('UsersService primary agentic tool', () => {
  dbTest('persists an explicit primary tool through the user patch surface', async ({ db }) => {
    const service = new UsersService(db);
    const { user } = await makeCaller(service);

    const updated = await service.patch(user.user_id as UserID, {
      primary_agentic_tool: 'codex',
    });

    expect(updated.primary_agentic_tool).toBe('codex');
    expect((await service.get(user.user_id as UserID)).primary_agentic_tool).toBe('codex');
  });

  dbTest('rejects invalid tool identifiers without changing the user', async ({ db }) => {
    const service = new UsersService(db);
    const { user } = await makeCaller(service);

    await expect(
      service.patch(
        user.user_id as UserID,
        {
          primary_agentic_tool: 'claude-code-cli',
        } as never
      )
    ).rejects.toThrow(/Invalid primary agentic tool/);

    expect((await service.get(user.user_id as UserID)).primary_agentic_tool).toBeUndefined();
  });

  dbTest('set-if-unset never replaces an explicit Settings preference', async ({ db }) => {
    const service = new UsersService(db);
    const { user, params } = await makeCaller(service);
    await service.patch(user.user_id as UserID, { primary_agentic_tool: 'codex' });

    const result = await service.setPrimaryAgenticToolIfUnset(
      { tool: 'gemini', expectedUserId: user.user_id },
      params
    );

    expect(result.primary_agentic_tool).toBe('codex');
    expect((await service.get(user.user_id as UserID)).primary_agentic_tool).toBe('codex');
  });

  dbTest('concurrent bootstrap attempts converge on one first writer', async ({ db }) => {
    const service = new UsersService(db);
    const { user, params } = await makeCaller(service);

    const results = await Promise.all([
      service.setPrimaryAgenticToolIfUnset({ tool: 'codex', expectedUserId: user.user_id }, params),
      service.setPrimaryAgenticToolIfUnset(
        { tool: 'gemini', expectedUserId: user.user_id },
        params
      ),
    ]);
    const persisted = (await service.get(user.user_id as UserID)).primary_agentic_tool;

    expect(['codex', 'gemini']).toContain(persisted);
    expect(results.map((result) => result.primary_agentic_tool)).toEqual([persisted, persisted]);
  });

  dbTest('bootstrap refuses an identity that changed before the RPC arrived', async ({ db }) => {
    const service = new UsersService(db);
    const { user: initiatingUser } = await makeCaller(service);
    const { user: authenticatedUser, params: authenticatedParams } = await makeCaller(service);

    await expect(
      service.setPrimaryAgenticToolIfUnset(
        { tool: 'codex', expectedUserId: initiatingUser.user_id },
        authenticatedParams
      )
    ).rejects.toThrow(/authority/i);

    expect(
      (await service.get(initiatingUser.user_id as UserID)).primary_agentic_tool
    ).toBeUndefined();
    expect(
      (await service.get(authenticatedUser.user_id as UserID)).primary_agentic_tool
    ).toBeUndefined();
  });

  dbTest('bootstrap requires an authenticated member', async ({ db }) => {
    const service = new UsersService(db);
    const { user } = await makeCaller(service);

    await expect(
      service.setPrimaryAgenticToolIfUnset(
        { tool: 'codex', expectedUserId: user.user_id },
        {} as never
      )
    ).rejects.toThrow(/Authentication required/);
    await expect(
      service.setPrimaryAgenticToolIfUnset({ tool: 'codex', expectedUserId: user.user_id }, {
        user: { user_id: user.user_id, role: 'viewer' },
      } as never)
    ).rejects.toThrow(/Member role/);
  });
});
