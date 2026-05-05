/**
 * Tests for UsersService.getGitEnvironment permission checks.
 *
 * Verifies that:
 * - Service-account JWTs can fetch any user's git environment
 * - User JWTs can only fetch their own git environment
 * - Unauthenticated callers are rejected
 */

import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

async function makeUser(service: UsersService): Promise<UserID> {
  const user = await service.create({
    email: `git-env-${Math.random().toString(36).slice(2)}@test.local`,
    password: 'test-password-1234',
  });
  return user.user_id;
}

describe('UsersService.getGitEnvironment — permission checks', () => {
  dbTest('service-account JWT can fetch any user env', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);

    const params: AuthenticatedParams = {
      provider: 'socketio',
      user: {
        user_id: 'executor-service',
        email: 'service@internal',
        role: 'service',
        _isServiceAccount: true,
      },
    };

    const env = await service.getGitEnvironment({ userId }, params);
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
  });

  dbTest('user JWT can fetch own env', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);

    const params: AuthenticatedParams = {
      provider: 'socketio',
      user: {
        user_id: userId,
        email: 'self@test.local',
        role: 'member',
      },
    };

    const env = await service.getGitEnvironment({ userId }, params);
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
  });

  dbTest('user JWT cannot fetch another user env', async ({ db }) => {
    const service = new UsersService(db);
    const userA = await makeUser(service);
    const userB = await makeUser(service);

    const params: AuthenticatedParams = {
      provider: 'socketio',
      user: {
        user_id: userA,
        email: 'a@test.local',
        role: 'member',
      },
    };

    // Service throws a Feathers `Forbidden` (which the HTTP/WS layer maps to 403)
    // with a human-readable message — assert both class and message so a future
    // change to either is caught.
    await expect(service.getGitEnvironment({ userId: userB }, params)).rejects.toThrow(Forbidden);
    await expect(service.getGitEnvironment({ userId: userB }, params)).rejects.toThrow(
      /Cannot access another user's git environment/
    );
  });

  dbTest('unauthenticated caller is rejected', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);

    const params: AuthenticatedParams = {
      provider: 'socketio',
      // no user
    };

    await expect(service.getGitEnvironment({ userId }, params)).rejects.toThrow(
      /Authentication required/
    );
  });

  dbTest('internal call (no provider) bypasses auth', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);

    // Internal calls have no provider — they bypass auth (Feathers convention)
    const env = await service.getGitEnvironment({ userId }, {});
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
  });

  dbTest('returns decrypted env vars for user with configured tokens', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);

    // Set an env var
    await service.patch(userId, {
      env_vars: { GITHUB_TOKEN: `ghp_${'x'.repeat(36)}` },
    });

    const env = await service.getGitEnvironment({ userId }, {});
    expect(env.GITHUB_TOKEN).toBe(`ghp_${'x'.repeat(36)}`);
  });

  dbTest('returns empty object for nonexistent user', async ({ db }) => {
    const service = new UsersService(db);
    const fakeId = '019e0000-0000-7000-8000-000000000000';

    const env = await service.getGitEnvironment({ userId: fakeId }, {});
    expect(env).toEqual({});
  });
});
