import type { ExecutorGitEnvironment as ExecutorGitEnvironmentDTO } from '@agor/core/api';
import { createTenantScopedDatabaseProxy, runWithTenantContext } from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import type { UserGitEnvironment } from '@agor/core/git/pure';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ExecutorGitEnvironmentService } from './executor-git-environment';
import { UsersService } from './users';

test('the public Git capability DTO matches the authoritative Git allowlist type', () => {
  expectTypeOf<ExecutorGitEnvironmentDTO>().toEqualTypeOf<UserGitEnvironment>();
});

async function makeUser(service: UsersService): Promise<UserID> {
  const user = await service.create({
    email: `git-capability-${Math.random().toString(36).slice(2)}@test.local`,
    password: 'test-password-1234',
  });
  return user.user_id;
}

function commandParams(
  userId: UserID,
  commandId: 'git.clone' | 'git.branch.add' | `git.branch.add:${string}` | 'environment-start'
): AuthenticatedParams {
  return {
    provider: 'socketio',
    user: { user_id: userId, email: 'executor@test.local', role: 'member' },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: 'executor-session',
        purpose: 'executor-command',
        session_id: commandId,
      },
    },
  } as AuthenticatedParams;
}

describe('ExecutorGitEnvironmentService', () => {
  dbTest('rejects ordinary, service, provider-less, and unrelated callers', async ({ db }) => {
    const users = new UsersService(db);
    const userId = await makeUser(users);
    const service = new ExecutorGitEnvironmentService(db);
    const ordinary = {
      provider: 'socketio',
      user: { user_id: userId, email: 'self@test.local', role: 'admin' },
      authentication: { strategy: 'jwt', payload: { type: 'access' } },
    } as AuthenticatedParams;
    const serviceAccount = {
      ...ordinary,
      user: {
        user_id: 'executor-service',
        email: 'service@internal',
        role: 'service',
        _isServiceAccount: true,
      },
    } as AuthenticatedParams;

    for (const params of [
      ordinary,
      serviceAccount,
      commandParams(userId, 'environment-start'),
      commandParams(userId, 'git.branch.add'),
    ]) {
      await expect(service.create({}, params)).rejects.toThrow(Forbidden);
    }
    await expect(service.create({}, { provider: 'socketio' })).rejects.toThrow(
      /Authentication required/
    );
    await expect(service.create({}, {})).rejects.toThrow(/authenticated transport/i);
  });

  dbTest("returns only the token principal's bounded Git DTO", async ({ db }) => {
    const users = new UsersService(db);
    const userId = await makeUser(users);
    await users.patch(userId, {
      env_vars: {
        GITHUB_TOKEN: `ghp_${'x'.repeat(36)}`,
        HTTPS_PROXY: 'https://user:password@proxy.example',
        STRIPE_API_KEY: 'unrelated-secret',
      },
    });

    const service = new ExecutorGitEnvironmentService(db);
    const env = await runWithTenantContext('tenant-test', () =>
      service.create({}, commandParams(userId, 'git.clone'))
    );
    expect(env).toEqual({
      GITHUB_TOKEN: `ghp_${'x'.repeat(36)}`,
      HTTPS_PROXY: 'https://user:password@proxy.example',
    });
  });

  dbTest('opens its own short tenant DB scope', async ({ db }) => {
    const users = new UsersService(db);
    const userId = await makeUser(users);
    await users.patch(userId, { env_vars: { GH_TOKEN: `ghp_${'s'.repeat(36)}` } });
    const guarded = createTenantScopedDatabaseProxy(db, {
      requireScope: true,
      label: 'executor-git-environment-test',
    });
    const service = new ExecutorGitEnvironmentService(guarded);

    await expect(
      runWithTenantContext('tenant-test', () =>
        service.create(
          {},
          commandParams(userId, 'git.branch.add:550e8400-e29b-41d4-a716-446655440004')
        )
      )
    ).resolves.toEqual({ GH_TOKEN: `ghp_${'s'.repeat(36)}` });
  });
});
