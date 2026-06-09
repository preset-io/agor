import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { SessionTokenService } from './session-token-service';

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
});
