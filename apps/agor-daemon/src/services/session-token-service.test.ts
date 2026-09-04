import {
  createTenantScopedDatabaseProxy,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import {
  fingerprintExecutorSessionToken,
  issueExecutorCommandToken,
  type SessionTokenAuthorityStore,
  SessionTokenService,
} from './session-token-service';

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
    isCurrent: vi.fn(async () => true),
    revoke: vi.fn(async () => true),
    revokeByTask: vi.fn(async () => []),
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

  it('allows command credentials to shorten but never extend configured expiry', async () => {
    const now = new Date('2026-08-23T00:00:00.000Z');
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { now: () => now, startCleanupTimer: false }
    );
    service.setJwtSecret('session-token-test-secret');

    const shortened = jwt.decode(
      await service.generateToken('branch-clean', 'user-1', { expirationMs: 10_000 })
    ) as jwt.JwtPayload;
    const capped = jwt.decode(
      await service.generateToken('branch-clean', 'user-1', { expirationMs: 120_000 })
    ) as jwt.JwtPayload;

    expect(shortened.exp! - shortened.iat!).toBe(10);
    expect(capped.exp! - capped.iat!).toBe(60);
    await expect(
      service.generateToken('branch-clean', 'user-1', { expirationMs: 0 })
    ).rejects.toThrow('token expiration must be positive');
  });

  it('centralizes the bounded taskless-command credential policy', async () => {
    const now = new Date('2026-08-23T00:00:00.000Z');
    const store = authorityStore();
    const service = new SessionTokenService(
      { expiration_ms: 60 * 60_000, max_uses: 1 },
      { authorityStore: store, now: () => now, startCleanupTimer: false }
    );
    service.setJwtSecret('session-token-test-secret');

    const token = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
      service.generateCommandToken('branch-clean', 'user-1', 'branch-1')
    );
    const decoded = jwt.decode(token) as jwt.JwtPayload;

    expect(decoded.purpose).toBe('executor-command');
    expect(decoded.exp! - decoded.iat!).toBe(15 * 60);
    expect(decoded.task_id).toBeUndefined();
    expect(decoded.branch_id).toBe('branch-1');
    expect(store.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        purpose: 'executor-command',
        sessionId: 'branch-clean',
        taskId: null,
        branchId: 'branch-1',
        userId: 'user-1',
      })
    );

    await expect(
      runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () => service.validateToken(token))
    ).resolves.toMatchObject({ session_id: 'branch-clean', user_id: 'user-1' });
    expect(store.validateAndConsume).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'executor-command', taskId: null })
    );
  });

  it('centralizes command issuance through the daemon-owned service', async () => {
    const generateCommandToken = vi.fn(async () => 'delegated-user-token');
    const app = { sessionTokenService: { generateCommandToken } };

    await expect(
      issueExecutorCommandToken(app, 'branch-files-read', 'user-1', 'branch-1')
    ).resolves.toBe('delegated-user-token');
    expect(generateCommandToken).toHaveBeenCalledWith('branch-files-read', 'user-1', 'branch-1');
    await expect(issueExecutorCommandToken({}, 'command', 'user-1')).rejects.toThrow(
      'Session token service unavailable'
    );
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

  it('revalidates one standalone Task fingerprint in O(1) and observes revocation', async () => {
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { startCleanupTimer: false }
    );
    service.setJwtSecret('session-token-test-secret');
    const token = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
      service.generateToken('session-1', 'user-1', {
        taskId: 'task-1',
        branchId: 'branch-1',
      })
    );
    const authority = {
      tenantId: 'tenant-a',
      tokenFingerprint: fingerprintExecutorSessionToken(token),
      sessionId: 'session-1',
      taskId: 'task-1',
      branchId: 'branch-1',
      userId: 'user-1',
    };

    await expect(service.isTaskTokenAuthorityCurrent(authority)).resolves.toBe(true);
    await expect(
      service.isTaskTokenAuthorityCurrent({ ...authority, branchId: 'branch-other' })
    ).resolves.toBe(false);
    await service.revokeToken(token);
    await expect(service.isTaskTokenAuthorityCurrent(authority)).resolves.toBe(false);
  });

  it('accepts only the exact retained workload receipt after Task-token revocation', async () => {
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { startCleanupTimer: false }
    );
    service.setJwtSecret('session-token-test-secret');
    const token = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
      service.generateToken('session-1', 'user-1', {
        taskId: 'task-1',
        branchId: 'branch-1',
      })
    );
    const receipt = {
      task_id: 'task-1',
      session_id: 'session-1',
      completion: {
        task_id: 'task-1',
        result_message_id: 'message-1',
      },
    };

    await service.revokeToken(token);
    await expect(service.validateRevokedWorkloadCompletionReceipt(token, receipt)).resolves.toEqual(
      {
        tenantId: 'tenant-a',
        userId: 'user-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        branchId: 'branch-1',
        resultMessageId: 'message-1',
      }
    );
    for (const invalidReceipt of [
      { ...receipt, task_id: 'task-2' },
      { ...receipt, session_id: 'session-2' },
      { ...receipt, completion: { ...receipt.completion, task_id: 'task-2' } },
      { ...receipt, extra: 'caller-authored' },
    ]) {
      await expect(
        service.validateRevokedWorkloadCompletionReceipt(token, invalidReceipt)
      ).resolves.toBeNull();
    }
    await expect(
      runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-b', () =>
        service.validateRevokedWorkloadCompletionReceipt(token, receipt)
      )
    ).resolves.toBeNull();

    const otherToken = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () =>
      service.generateToken('session-2', 'user-2', {
        taskId: 'task-2',
        branchId: 'branch-1',
      })
    );
    await service.revokeToken(otherToken);
    await expect(
      service.validateRevokedWorkloadCompletionReceipt(otherToken, receipt)
    ).resolves.toBeNull();
    await expect(
      service.validateRevokedWorkloadCompletionReceipt(token, receipt)
    ).resolves.toMatchObject({
      taskId: 'task-1',
    });
  });

  it('fails heartbeat authority closed when the durable store is uncertain', async () => {
    const store = authorityStore({
      isCurrent: vi.fn(async () => {
        throw new Error('authority store unavailable');
      }),
    });
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { authorityStore: store, startCleanupTimer: false }
    );

    await expect(
      service.isTaskTokenAuthorityCurrent({
        tenantId: 'tenant-a',
        tokenFingerprint: 'c'.repeat(64),
        sessionId: 'session-1',
        taskId: 'task-1',
        branchId: 'branch-1',
        userId: 'user-1',
      })
    ).rejects.toThrow('authority store unavailable');
  });

  it('preserves standalone expiry, revocation, and cleanup behavior', async () => {
    let now = new Date('2026-08-07T00:00:00.000Z');
    const guardedSqliteDb = createTenantScopedDatabaseProxy(scopeOnlyDb, {
      requireScope: true,
      label: 'standalone token test',
    });
    const onRevoked = vi.fn();
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { db: guardedSqliteDb, now: () => now, startCleanupTimer: false, onRevoked }
    );
    service.setJwtSecret('session-token-test-secret');

    const revoked = await service.generateToken('session-1', 'user-1');
    expect(service.getActiveTokenCount()).toBe(1);
    await expect(service.revokeToken(revoked)).resolves.toBe(true);
    expect(onRevoked).toHaveBeenCalledWith({
      tokenFingerprint: fingerprintExecutorSessionToken(revoked),
    });
    await expect(service.validateToken(revoked)).resolves.toBeNull();

    const expired = await service.generateToken('session-2', 'user-1');
    now = new Date('2026-08-07T00:02:00.000Z');
    await expect(service.validateToken(expired)).resolves.toBeNull();
    await expect(service.cleanupExpiredTokens()).resolves.toBe(1);
    expect(service.getActiveTokenCount()).toBe(0);
  });

  it('retires every standalone bearer for one terminal task without widening to its session', async () => {
    const onRevoked = vi.fn();
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { startCleanupTimer: false, onRevoked }
    );
    service.setJwtSecret('session-token-test-secret');
    const first = await service.generateToken('session-1', 'user-1', { taskId: 'task-1' });
    const retry = await service.generateToken('session-1', 'user-1', { taskId: 'task-1' });
    const sibling = await service.generateToken('session-1', 'user-1', { taskId: 'task-2' });

    await expect(service.revokeTaskTokens('task-1')).resolves.toBe(2);
    await expect(service.validateToken(first)).resolves.toBeNull();
    await expect(service.validateToken(retry)).resolves.toBeNull();
    await expect(service.validateToken(sibling)).resolves.toMatchObject({ task_id: 'task-2' });
    expect(onRevoked).toHaveBeenCalledTimes(2);
  });

  it('uses tenant-scoped durable task revocation and relays only fingerprints', async () => {
    const fingerprint = 'a'.repeat(64);
    const store = authorityStore({ revokeByTask: vi.fn(async () => [fingerprint]) });
    const onRevoked = vi.fn();
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      { authorityStore: store, startCleanupTimer: false, onRevoked }
    );

    await expect(
      runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', () => service.revokeTaskTokens('task-1'))
    ).resolves.toBe(1);
    expect(store.revokeByTask).toHaveBeenCalledWith('task-1', 'tenant-a');
    expect(onRevoked).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      tokenFingerprint: fingerprint,
    });
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
