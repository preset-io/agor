import { runWithTenantDatabaseScope, type TenantScopeAwareDatabase } from '@agor/core/db';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionTokenService } from './session-token-service';

const scopeOnlyDb = { run: () => undefined } as unknown as TenantScopeAwareDatabase;

describe('SessionTokenService runtime scoping', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues executor-purpose tokens with task/session/branch scope and enforces max uses', async () => {
    const service = new SessionTokenService({ expiration_ms: 60_000, max_uses: 1 });
    service.setJwtSecret('session-token-test-secret');

    const token = await service.generateToken('session-1', 'user-1', {
      taskId: 'task-1',
      executorAttemptId: 'attempt-1',
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
    expect(decoded.executor_attempt_id).toBe('attempt-1');
    expect(decoded.jti).toEqual(expect.any(String));
    expect(decoded.branch_id).toBe('branch-1');

    await expect(
      service.validateToken(token, { sessionId: 'session-1', taskId: 'task-other' })
    ).resolves.toBeNull();
    await expect(
      service.validateToken(token, {
        sessionId: 'session-1',
        taskId: 'task-1',
        executorAttemptId: 'attempt-1',
      })
    ).resolves.toMatchObject({
      session_id: 'session-1',
      task_id: 'task-1',
      executor_attempt_id: 'attempt-1',
    });
    await expect(
      service.validateToken(token, { sessionId: 'session-1', taskId: 'task-1' })
    ).resolves.toBeNull();
  });

  it('supersedes only earlier task tokens for the same session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'));
    const service = new SessionTokenService({ expiration_ms: 60_000, max_uses: -1 });
    service.setJwtSecret('session-token-test-secret');

    const oldToken = await service.generateToken('session-1', 'user-1', {
      taskId: 'task-old',
      executorAttemptId: 'attempt-old',
    });
    const otherSessionToken = await service.generateToken('session-2', 'user-1', {
      taskId: 'task-other',
      executorAttemptId: 'attempt-other',
    });
    const currentToken = await service.generateToken('session-1', 'user-1', {
      taskId: 'task-current',
      executorAttemptId: 'attempt-current',
    });

    expect(oldToken).not.toBe(currentToken);
    await expect(service.validateToken(oldToken)).resolves.toBeNull();
    await expect(service.validateToken(otherSessionToken)).resolves.toMatchObject({
      session_id: 'session-2',
      task_id: 'task-other',
    });

    // Late cleanup from the old process must not revoke the replacement.
    service.revokeToken(oldToken);

    await expect(
      service.validateToken(currentToken, {
        sessionId: 'session-1',
        taskId: 'task-current',
        executorAttemptId: 'attempt-current',
      })
    ).resolves.toMatchObject({ executor_attempt_id: 'attempt-current' });
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
});
