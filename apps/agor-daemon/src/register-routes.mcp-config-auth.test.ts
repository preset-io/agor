import { Forbidden } from '@agor/core/feathers';
import type { HookContext, Session } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { executorRuntimeScopeGuard } from './auth/executor-runtime-scope.js';
import { authorizeSessionMcpConfigAccess } from './register-routes.js';

const session = {
  session_id: 'session-1',
  created_by: 'session-owner',
} as Session;

function harness(options: {
  userId?: string;
  role?: string;
  scopedSessionId?: string;
  allowTaskScopedExecutorRead?: boolean;
}) {
  return {
    sessionId: 'session-1',
    params: {
      provider: 'socketio',
      query: {},
      route: { id: 'session-1' },
      user: { user_id: options.userId ?? 'collaborator', role: options.role ?? 'member' },
      authentication: options.scopedSessionId
        ? {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              session_id: options.scopedSessionId,
              task_id: 'task-1',
              branch_id: 'branch-1',
            },
          }
        : undefined,
    } as never,
    sessionsService: {
      get: vi.fn().mockResolvedValue(session),
    } as never,
    superadminOpts: { allowSuperadmin: true },
    allowTaskScopedExecutorRead: options.allowTaskScopedExecutorRead,
  };
}

describe('session MCP configuration authorization', () => {
  it('allows the session owner', async () => {
    await expect(
      authorizeSessionMcpConfigAccess(harness({ userId: 'session-owner' }))
    ).resolves.toBe(session);
  });

  it('allows an exact-session executor credential to read for its collaborator task', async () => {
    const input = harness({ scopedSessionId: 'session-1', allowTaskScopedExecutorRead: true });
    const routeContext = {
      path: 'sessions/:id/mcp-servers',
      method: 'find',
      params: input.params,
    } as HookContext;

    await expect(executorRuntimeScopeGuard()(routeContext)).resolves.toBe(routeContext);
    await expect(
      authorizeSessionMcpConfigAccess({ ...input, params: routeContext.params as never })
    ).resolves.toBe(session);
  });

  it('rejects a normal collaborator', async () => {
    await expect(authorizeSessionMcpConfigAccess(harness({}))).rejects.toBeInstanceOf(Forbidden);
  });

  it('rejects an executor credential scoped to another session', async () => {
    await expect(
      authorizeSessionMcpConfigAccess(
        harness({ scopedSessionId: 'session-2', allowTaskScopedExecutorRead: true })
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it('does not extend executor authorization to mutation callers', async () => {
    await expect(
      authorizeSessionMcpConfigAccess(
        harness({ scopedSessionId: 'session-1', allowTaskScopedExecutorRead: false })
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });
});
