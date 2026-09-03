/**
 * Verifies the terminal-executor rejection guard is actually COMPOSED into the
 * shared `requireAuth` hook — not just that the guard throws in isolation. A
 * future refactor that drops the composition would fail here.
 */

import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { finalizeAuthenticatedConnectionAuthority } from './authenticated-connection-authority';
import {
  attachExecutorConnectionCandidate,
  getOrCreateExecutorConnectionRevocationFence,
} from './executor-connection-admission';
import { createRequireAuthHook } from './require-auth';

const multiTenancy = { mode: 'static' as const, static_tenant_id: 'tenant-default' as never };

function ctxWithUser(user: unknown): HookContext {
  return { params: { provider: 'rest', user } } as unknown as HookContext;
}

function receiptContext(method: string): HookContext {
  const connection: Record<string, unknown> = {};
  const authResult = {
    user: { user_id: 'user-1', role: 'member' },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: 'executor-session',
        purpose: 'executor-task',
        sub: 'user-1',
        tenant_id: 'tenant-default',
        session_id: 'session-1',
        task_id: 'task-1',
        branch_id: 'branch-1',
      },
    },
  };
  attachExecutorConnectionCandidate(authResult, {
    tenantId: 'tenant-default',
    taskId: 'task-1',
    tokenFingerprint: 'a'.repeat(64),
    revocationGeneration: 0,
    completionReceipt: {
      taskId: 'task-1',
      sessionId: 'session-1',
      resultMessageId: 'message-1',
    },
  });
  finalizeAuthenticatedConnectionAuthority({
    connection,
    authResult,
    multiTenancy,
    executorRevocationFence: getOrCreateExecutorConnectionRevocationFence({}),
  });
  return {
    path: 'tasks',
    method,
    data: { task_id: 'task-1', result_message_id: 'message-1' },
    params: {
      provider: 'socketio',
      connection,
      user: connection.user,
      authentication: connection.authentication,
    },
  } as unknown as HookContext;
}

describe('createRequireAuthHook composition', () => {
  it('rejects a terminal-executor identity that passed the auth strategy', async () => {
    // The strategy authenticated the token (that part must work for socket
    // reconnect); requireAuth must still reject it for REST/Feathers.
    const authenticatedHook = vi.fn(async (ctx: HookContext) => ctx);
    const requireAuth = createRequireAuthHook(authenticatedHook, multiTenancy);

    await expect(
      requireAuth(
        ctxWithUser({
          user_id: 'executor-service',
          role: 'terminal-executor',
          _isTerminalExecutor: true,
        })
      )
    ).rejects.toBeInstanceOf(Forbidden);
    expect(authenticatedHook).toHaveBeenCalled();
  });

  it('passes a normal authenticated user through and resolves the tenant', async () => {
    const authenticatedHook = vi.fn(async (ctx: HookContext) => ctx);
    const requireAuth = createRequireAuthHook(authenticatedHook, multiTenancy);

    const result = await requireAuth(ctxWithUser({ user_id: 'u1', role: 'member' }));
    expect((result.params as { tenant?: { tenant_id: string } }).tenant?.tenant_id).toBe(
      'tenant-default'
    );
  });

  it('passes a full service account through (not a terminal-executor)', async () => {
    const authenticatedHook = vi.fn(async (ctx: HookContext) => ctx);
    const requireAuth = createRequireAuthHook(authenticatedHook, multiTenancy);

    await expect(
      requireAuth(
        ctxWithUser({ user_id: 'executor-service', role: 'service', _isServiceAccount: true })
      )
    ).resolves.toBeDefined();
  });

  it('limits a retired completion receipt to the exact reconciliation method', async () => {
    const authenticatedHook = vi.fn(async (ctx: HookContext) => ctx);
    const requireAuth = createRequireAuthHook(authenticatedHook, multiTenancy);

    await expect(requireAuth(receiptContext('get'))).rejects.toBeInstanceOf(NotAuthenticated);
    await expect(requireAuth(receiptContext('reconcileWorkloadCompletion'))).resolves.toBeDefined();
  });
});
