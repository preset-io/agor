/**
 * Tests for UsersService.getGitEnvironment permission checks.
 *
 * Verifies that:
 * - Service-account JWTs can fetch any user's git environment
 * - User JWTs can only fetch their own git environment
 * - Unauthenticated callers are rejected
 */

import {
  BranchRepository,
  executeRaw,
  generateId,
  RepoRepository,
  SessionEnvSelectionRepository,
  SessionRepository,
  sql,
} from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID, SessionID, UserID, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
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

  dbTest('does not let the legacy environment helper bypass session scope', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);
    await service.patch(userId, {
      env_vars: {
        GLOBAL_CANARY: 'global-value',
        SESSION_CANARY: 'session-value',
      },
    });
    await service.patch(userId, { env_var_scopes: { SESSION_CANARY: 'session' } });

    expect(await service.getEnvironmentVariables(userId)).toEqual({
      GLOBAL_CANARY: 'global-value',
    });
  });

  dbTest('projects only env-var metadata to self and foreign admins', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);
    const plaintext = 'dto-canary-value-that-must-never-be-serialized';

    const patched = await service.patch(userId, {
      env_vars: { DTO_SECRET: plaintext },
    });
    const self = await service.get(userId, {
      provider: 'socketio',
      user: {
        user_id: userId,
        email: 'self@test.local',
        role: 'member',
      },
    } satisfies AuthenticatedParams);
    const foreignAdmin = await service.get(userId, {
      provider: 'socketio',
      user: {
        user_id: generateId() as UserID,
        email: 'admin@test.local',
        role: 'admin',
      },
    } satisfies AuthenticatedParams);

    for (const dto of [patched, self, foreignAdmin]) {
      expect(dto.env_vars).toEqual({
        DTO_SECRET: { set: true, scope: 'global', resource_id: null },
      });
      expect(JSON.stringify(dto)).not.toContain(plaintext);
      expect(JSON.stringify(dto)).not.toContain('value_encrypted');
    }
  });

  dbTest('returns empty object for nonexistent user', async ({ db }) => {
    const service = new UsersService(db);
    const fakeId = '019e0000-0000-7000-8000-000000000000';

    const env = await service.getGitEnvironment({ userId: fakeId }, {});
    expect(env).toEqual({});
  });

  dbTest('removes stale selections when a variable is deleted or made global', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);
    const repo = await new RepoRepository(db).create({
      repo_id: generateId() as UUID,
      slug: `env-selection-cleanup-${generateId()}`,
      name: 'Env selection cleanup',
      repo_type: 'remote',
      remote_url: 'https://github.com/test/repo.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'main',
      ref: 'main',
      branch_unique_id: 987_654,
      path: `/tmp/${generateId()}`,
      created_by: userId,
    });
    const session = await new SessionRepository(db).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      agentic_tool: 'codex',
      status: SessionStatus.IDLE,
      created_by: userId,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      tasks: [],
      contextFiles: [],
      genealogy: { children: [] },
    });
    const selections = new SessionEnvSelectionRepository(db);

    await service.patch(userId, { env_vars: { SESSION_SECRET: 'first-secret' } });
    await service.patch(userId, { env_var_scopes: { SESSION_SECRET: 'session' } });
    await selections.add(session.session_id, 'SESSION_SECRET');
    await service.patch(userId, { env_vars: { SESSION_SECRET: null } });
    expect(await selections.listNames(session.session_id)).toEqual([]);

    await service.patch(userId, { env_vars: { SESSION_SECRET: 'second-secret' } });
    await service.patch(userId, { env_var_scopes: { SESSION_SECRET: 'session' } });
    await selections.add(session.session_id, 'SESSION_SECRET');
    await service.patch(userId, { env_var_scopes: { SESSION_SECRET: 'global' } });
    expect(await selections.listNames(session.session_id)).toEqual([]);
  });

  dbTest('rolls back the secret mutation when selection cleanup fails', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);
    const repo = await new RepoRepository(db).create({
      repo_id: generateId() as UUID,
      slug: `env-selection-rollback-${generateId()}`,
      name: 'Env selection rollback',
      repo_type: 'remote',
      remote_url: 'https://github.com/test/repo.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'main',
      ref: 'main',
      branch_unique_id: 987_655,
      path: `/tmp/${generateId()}`,
      created_by: userId,
    });
    const session = await new SessionRepository(db).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id,
      agentic_tool: 'codex',
      status: SessionStatus.IDLE,
      created_by: userId,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      tasks: [],
      contextFiles: [],
      genealogy: { children: [] },
    });
    const selections = new SessionEnvSelectionRepository(db);
    await service.patch(userId, { env_vars: { SESSION_SECRET: 'rollback-canary' } });
    await service.patch(userId, { env_var_scopes: { SESSION_SECRET: 'session' } });
    await selections.add(session.session_id, 'SESSION_SECRET');
    await executeRaw(
      db,
      sql`CREATE TRIGGER env_selection_cleanup_abort
          BEFORE DELETE ON session_env_selections
          BEGIN
            SELECT RAISE(ABORT, 'selection cleanup failed');
          END`
    );

    await expect(service.patch(userId, { env_vars: { SESSION_SECRET: null } })).rejects.toThrow(
      /delete from "session_env_selections"/i
    );
    expect((await service.get(userId)).env_vars?.SESSION_SECRET).toEqual({
      set: true,
      scope: 'session',
      resource_id: null,
    });
    expect(await selections.listNames(session.session_id)).toEqual(['SESSION_SECRET']);
  });

  dbTest('serializes concurrent env-map patches without losing either value', async ({ db }) => {
    const service = new UsersService(db);
    const userId = await makeUser(service);
    type PatchAuthority = (
      id: Parameters<UsersService['patch']>[0],
      data: Parameters<UsersService['patch']>[1],
      params?: Parameters<UsersService['patch']>[2]
    ) => Promise<unknown>;
    const serviceInternals = service as unknown as { authorizePatch: PatchAuthority };
    const authorize = serviceInternals.authorizePatch.bind(service);
    let calls = 0;
    let firstEnteredResolve!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      firstEnteredResolve = resolve;
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const authorizeSpy = vi
      .spyOn(serviceInternals, 'authorizePatch')
      .mockImplementation(async (...args) => {
        const authority = await authorize(...args);
        calls += 1;
        if (calls === 1) {
          firstEnteredResolve();
          await firstBlocked;
        }
        return authority;
      });

    const first = service.patch(userId, { env_vars: { FIRST_SECRET: 'first-value' } });
    await firstEntered;
    const second = service.patch(userId, { env_vars: { SECOND_SECRET: 'second-value' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(authorizeSpy).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    vi.restoreAllMocks();

    const metadata = (await service.get(userId)).env_vars;
    expect(Object.keys(metadata ?? {}).sort()).toEqual(['FIRST_SECRET', 'SECOND_SECRET']);
  });
});
