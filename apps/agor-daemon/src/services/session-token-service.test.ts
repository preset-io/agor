import {
  createTenantScopedDatabaseProxy,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { type SessionTokenAuthorityStore, SessionTokenService } from './session-token-service';

const scopeOnlyDb = { run: () => undefined } as unknown as TenantScopeAwareDatabase;

function authorityStore(
  overrides: Partial<SessionTokenAuthorityStore> = {}
): SessionTokenAuthorityStore {
  return {
    issue: vi.fn(async () => undefined),
    validateAndConsume: vi.fn(async (input) => ({
      session_id: input.sessionId,
      ...(input.taskId ? { task_id: input.taskId } : {}),
      ...(input.branchId ? { branch_id: input.branchId } : {}),
      user_id: input.userId,
    })),
    revoke: vi.fn(async () => true),
    revokeSession: vi.fn(async () => 0),
    purgeRetained: vi.fn(async () => 0),
    ...overrides,
  };
}

describe('SessionTokenService runtime scoping', () => {
  it('issues executor-purpose tokens with task/session/branch scope and enforces max uses', async () => {
    const service = new SessionTokenService({ expiration_ms: 60_000, max_uses: 1 });
    service.setJwtSecret('session-token-test-secret');

    const token = await service.generateToken('session-1', 'user-1', {
      taskId: 'task-1',
      branchId: 'branch-1',
    });
    const decoded = jwt.verify(token, 'session-token-test-secret', {
      issuer: 'agor',
      audience: 'https://agor.dev',
    }) as jwt.JwtPayload;

    expect(decoded.type).toBe('executor-session');
    expect(decoded.purpose).toBe('executor-task');
    expect(decoded.session_id).toBe('session-1');
    expect(decoded.task_id).toBe('task-1');
    expect(decoded.branch_id).toBe('branch-1');

    await expect(
      service.validateToken(token, { sessionId: 'session-1', taskId: 'task-other' })
    ).resolves.toBeNull();
    await expect(
      service.validateToken(token, { sessionId: 'session-1', taskId: 'task-1' })
    ).resolves.toMatchObject({ session_id: 'session-1', task_id: 'task-1' });
    await expect(
      service.validateToken(token, { sessionId: 'session-1', taskId: 'task-1' })
    ).resolves.toBeNull();
  });

  it('can issue reusable scoped runtime tokens when per-call max-use counting is not suitable', async () => {
    const service = new SessionTokenService({ expiration_ms: 60_000, max_uses: 1 });
    service.setJwtSecret('session-token-test-secret');

    const token = await service.generateToken('session-1', 'user-1', {
      taskId: 'task-1',
      branchId: 'branch-1',
      maxUses: -1,
    });

    await expect(
      service.validateToken(token, {
        sessionId: 'session-1',
        taskId: 'task-1',
        branchId: 'branch-1',
      })
    ).resolves.toMatchObject({ session_id: 'session-1', task_id: 'task-1' });
    await expect(
      service.validateToken(token, {
        sessionId: 'session-1',
        taskId: 'task-1',
        branchId: 'branch-1',
      })
    ).resolves.toMatchObject({ session_id: 'session-1', task_id: 'task-1' });
  });

  it('copies the ambient tenant scope into executor-session token claims', async () => {
    const service = new SessionTokenService({ expiration_ms: 60_000, max_uses: 1 });
    service.setJwtSecret('session-token-test-secret');

    const token = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
      service.generateToken('session-1', 'user-1', {
        taskId: 'task-1',
        branchId: 'branch-1',
      })
    );
    const decoded = jwt.verify(token, 'session-token-test-secret', {
      issuer: 'agor',
      audience: 'https://agor.dev',
    }) as jwt.JwtPayload;

    expect(decoded.tenant_id).toBe('tenant-a');
  });

  it('binds tenant, user, task, and branch before consuming a bounded local token', async () => {
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: 1 },
      { startCleanupTimer: false }
    );
    service.setJwtSecret('session-token-test-secret');

    const token = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
      service.generateToken('session-1', 'user-1', {
        taskId: 'task-1',
        branchId: 'branch-1',
      })
    );

    for (const wrongScope of [
      { tenantId: 'tenant-b' },
      { userId: 'user-2' },
      { sessionId: 'session-2' },
      { taskId: 'task-2' },
      { branchId: 'branch-2' },
    ]) {
      await expect(service.validateToken(token, wrongScope)).resolves.toBeNull();
    }
    await expect(
      runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-b', () => service.validateToken(token))
    ).resolves.toBeNull();

    // Wrong-scope attempts do not consume the single valid use.
    await expect(
      runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
        service.validateToken(token, {
          tenantId: 'tenant-a',
          userId: 'user-1',
          sessionId: 'session-1',
          taskId: 'task-1',
          branchId: 'branch-1',
        })
      )
    ).resolves.toMatchObject({ session_id: 'session-1', user_id: 'user-1' });
  });

  it('preserves standalone expiry, revocation, and cleanup behavior', async () => {
    let now = new Date('2026-08-07T00:00:00.000Z');
    const guardedSqliteDb = createTenantScopedDatabaseProxy(scopeOnlyDb, {
      requireScope: true,
      label: 'standalone token test',
    });
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { db: guardedSqliteDb, now: () => now, startCleanupTimer: false }
    );
    service.setJwtSecret('session-token-test-secret');

    const revoked = await service.generateToken('session-1', 'user-1');
    expect(service.getActiveTokenCount()).toBe(1);
    await expect(service.revokeToken(revoked)).resolves.toBe(true);
    await expect(service.validateToken(revoked)).resolves.toBeNull();

    const expired = await service.generateToken('session-2', 'user-1');
    now = new Date('2026-08-07T00:02:00.000Z');
    await expect(service.validateToken(expired)).resolves.toBeNull();
    await expect(service.cleanupExpiredTokens()).resolves.toBe(1);
    expect(service.getActiveTokenCount()).toBe(0);
  });

  it('persists only a fingerprint and fails issuance before returning a bearer', async () => {
    const store = authorityStore();
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { authorityStore: store, startCleanupTimer: false }
    );
    service.setJwtSecret('session-token-test-secret');

    const token = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
      service.generateToken('session-1', 'user-1', {
        taskId: 'task-1',
        branchId: 'branch-1',
      })
    );
    const issue = vi.mocked(store.issue).mock.calls[0]?.[0];
    expect(issue).toMatchObject({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      taskId: 'task-1',
      branchId: 'branch-1',
      userId: 'user-1',
    });
    expect(issue?.tokenFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(issue)).not.toContain(token);

    const failedStore = authorityStore({
      issue: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    const failing = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { authorityStore: failedStore, startCleanupTimer: false }
    );
    failing.setJwtSecret('session-token-test-secret');
    await expect(
      runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
        failing.generateToken('session-1', 'user-1')
      )
    ).rejects.toThrow('database unavailable');
  });

  it('fails shared authentication closed on authority errors and never falls back locally', async () => {
    const store = authorityStore({
      validateAndConsume: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { authorityStore: store, startCleanupTimer: false }
    );
    service.setJwtSecret('session-token-test-secret');

    const token = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
      service.generateToken('session-1', 'user-1')
    );
    await expect(
      runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () => service.validateToken(token))
    ).rejects.toThrow('database unavailable');
    expect(service.getActiveTokenCount()).toBe(0);
  });

  it('refuses PostgreSQL mode without an injected database authority', () => {
    vi.stubEnv('AGOR_DB_DIALECT', 'postgresql');
    try {
      expect(
        () =>
          new SessionTokenService(
            { expiration_ms: 60_000, max_uses: -1 },
            { startCleanupTimer: false }
          )
      ).toThrow('requires its PostgreSQL database authority');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
