/**
 * Verifies the terminal-executor rejection guard is actually COMPOSED into the
 * shared `requireAuth` hook — not just that the guard throws in isolation. A
 * future refactor that drops the composition would fail here.
 */

import { Forbidden } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { getLogContext } from '@agor/core/utils/log-context';
import { describe, expect, it, vi } from 'vitest';
import { createTenantDatabaseScopeAroundHook } from '../utils/tenant-db-scope';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from './executor-session-token';
import { createRequireAuthHook } from './require-auth';

const multiTenancy = { mode: 'static' as const, static_tenant_id: 'tenant-default' as never };

function ctxWithUser(user: unknown): HookContext {
  return { params: { provider: 'rest', user } } as unknown as HookContext;
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
});

describe('requireAuth log context (REST-shaped chain)', () => {
  // Around hook → requireAuth before hook → service method, with no
  // params.user on entry: the strategy hook is what attaches the caller.
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ execute: vi.fn(async () => []) })
    ),
  };
  const around = createTenantDatabaseScopeAroundHook({
    db: db as never,
    jwtSecret: 'secret',
    config: { multi_tenancy: { mode: 'static', static_tenant_id: 'tenant-default' } },
  });

  async function call(
    authenticate: (params: Record<string, unknown>) => void,
    delayMs = 0
  ): Promise<Record<string, string>> {
    const authenticatedHook = vi.fn(async (ctx: HookContext) => {
      authenticate(ctx.params as Record<string, unknown>);
      return ctx;
    });
    const requireAuth = createRequireAuthHook(authenticatedHook, multiTenancy);
    const context = { params: { provider: 'rest' } } as unknown as HookContext;
    let logged: Record<string, string> = {};
    await around(context, async () => {
      await requireAuth(context);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      logged = getLogContext();
    });
    return logged;
  }

  it('stamps user_id for a JWT caller', async () => {
    const logged = await call((params) => {
      params.user = { user_id: 'user-jwt', role: 'member' };
      params.authentication = { strategy: 'jwt', payload: { sub: 'user-jwt' } };
    });
    expect(logged).toEqual({ tenant_id: 'tenant-default', user_id: 'user-jwt' });
  });

  it('stamps user_id for a personal API key caller', async () => {
    const logged = await call((params) => {
      params.user = { user_id: 'user-key', role: 'member' };
      params.authentication = { strategy: 'api-key' };
    });
    expect(logged.user_id).toBe('user-key');
  });

  it('has no user_id for an unauthenticated call', async () => {
    const authenticatedHook = vi.fn(async () => {
      throw new Error('not authenticated');
    });
    const requireAuth = createRequireAuthHook(authenticatedHook, multiTenancy);
    const context = { params: { provider: 'rest' } } as unknown as HookContext;
    let logged: Record<string, string> = {};
    await around(context, async () => {
      await requireAuth(context).catch(() => undefined);
      logged = getLogContext();
    });
    expect(logged).toEqual({ tenant_id: 'tenant-default' });
  });

  it('never mixes concurrent callers', async () => {
    const [a, b] = await Promise.all([
      call((params) => {
        params.user = { user_id: 'user-a', role: 'member' };
      }, 5),
      call((params) => {
        params.user = { user_id: 'user-b', role: 'member' };
      }, 1),
    ]);
    expect(a.user_id).toBe('user-a');
    expect(b.user_id).toBe('user-b');
  });

  it('carries the executor token session and task', async () => {
    const logged = await call((params) => {
      params.user = { user_id: 'user-exec', role: 'member' };
      params.authentication = {
        strategy: 'jwt',
        payload: {
          sub: 'user-exec',
          type: EXECUTOR_SESSION_TOKEN_TYPE,
          purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
          session_id: 'session-1',
          task_id: 'task-1',
          branch_id: 'branch-1',
        },
      };
    });
    expect(logged).toEqual({
      tenant_id: 'tenant-default',
      user_id: 'user-exec',
      session_id: 'session-1',
      task_id: 'task-1',
      branch_id: 'branch-1',
    });
  });
});
