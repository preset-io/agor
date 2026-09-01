import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session, Task } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { authorizeTaskExecutorSessionMcpRead, type RouteParams } from './register-routes';

const session = {
  session_id: 'session-a',
  created_by: 'alice',
} as Session;

function executorParams(overrides: Record<string, unknown> = {}): RouteParams {
  return {
    provider: 'rest',
    authenticated: true,
    user: { user_id: 'bob', role: 'member' },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: 'executor-session',
        purpose: 'executor-task',
        session_id: 'session-a',
        task_id: 'task-b',
        sub: 'bob',
        ...overrides,
      },
    },
  } as RouteParams;
}

const task = {
  task_id: 'task-b',
  session_id: 'session-a',
  created_by: 'bob',
} as Task;

describe('Session MCP executor read scope', () => {
  it('admits the actual Task actor on a shared Session', async () => {
    const findTask = vi.fn(async () => task);

    await expect(
      authorizeTaskExecutorSessionMcpRead(executorParams(), session, findTask)
    ).resolves.toBe(true);
    expect(findTask).toHaveBeenCalledWith('task-b');
  });

  it('rejects another Session, Task, or prompt actor', async () => {
    await expect(
      authorizeTaskExecutorSessionMcpRead(
        executorParams({ session_id: 'session-other' }),
        session,
        async () => task
      )
    ).rejects.toThrow('not scoped to this session');
    await expect(
      authorizeTaskExecutorSessionMcpRead(executorParams(), session, async () => ({
        ...task,
        task_id: 'task-other',
      }))
    ).rejects.toThrow('no longer current');
    await expect(
      authorizeTaskExecutorSessionMcpRead(executorParams(), session, async () => ({
        ...task,
        created_by: 'alice',
      }))
    ).rejects.toThrow('no longer current');
  });

  it('does not grant ordinary browser callers an executor exemption', async () => {
    await expect(
      authorizeTaskExecutorSessionMcpRead(
        {
          provider: 'rest',
          authenticated: true,
          user: { user_id: 'bob', role: 'member' },
          authentication: { strategy: 'jwt', payload: { type: 'access', sub: 'bob' } },
        } as RouteParams,
        session,
        vi.fn()
      )
    ).resolves.toBe(false);
  });

  it('keeps every MCP relationship mutation behind the owner/admin boundary', () => {
    const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    const routeStart = source.indexOf("'/sessions/:id/mcp-servers'");
    const routeEnd = source.indexOf('// MCP member policy', routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(0);
    expect(route.match(/requireSessionScopedConfigOwnerOrAdmin\(id, params\)/g)).toHaveLength(4);
    expect(route.match(/authorizeAndLoadSessionForMcpConfig\(id, params\)/g)).toHaveLength(1);
  });
});
