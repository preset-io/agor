import type { HookContext, Params } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  authenticatedExecutorCommandRuntimeScope,
  authenticatedTaskExecutorRuntimeAuthority,
  authenticatedTaskExecutorRuntimeScope,
  executorRuntimeScopeSessionId,
  isTaskScopedExecutorRequest,
  matchesExecutorCommandRuntimeScope,
  matchesTaskExecutorRuntimeScope,
  requireTaskScopedExecutorRuntimeToken,
} from './executor-runtime-scope.js';

const taskPayload = {
  type: 'executor-session',
  purpose: 'executor-task',
  session_id: 'session-1',
  task_id: 'task-1',
  branch_id: 'branch-1',
};

function params(payload: Record<string, unknown> = taskPayload): Params {
  return {
    authentication: { strategy: 'jwt', payload },
    provider: 'socketio',
  } as Params;
}

function context(overrides: Partial<HookContext> = {}): HookContext {
  return {
    path: 'tasks',
    method: 'connectExecutor',
    data: { task_id: 'task-1' },
    params: params(),
    ...overrides,
  } as HookContext;
}

describe('executor runtime authentication context', () => {
  it('projects task context only from a verified executor JWT payload', () => {
    expect(authenticatedTaskExecutorRuntimeScope(params())).toEqual({
      sessionId: 'session-1',
      taskId: 'task-1',
      branchId: 'branch-1',
    });

    expect(() =>
      authenticatedTaskExecutorRuntimeScope({
        authentication: { strategy: 'jwt', payload: { ...taskPayload, purpose: 'wrong' } },
      } as Params)
    ).toThrow(/not valid/);
  });

  it('does not derive authority from caller-controlled transport fields', () => {
    expect(
      authenticatedTaskExecutorRuntimeScope({
        provider: 'socketio',
        authentication: { strategy: 'local' },
        headers: { authorization: 'Bearer forged' },
        query: { session_id: 'session-1', task_id: 'task-1' },
      } as Params)
    ).toBeNull();
  });

  it('derives REST heartbeat authority only from verified claims and the authenticated bearer', () => {
    const accessToken = 'already-verified-task-bearer';
    expect(
      authenticatedTaskExecutorRuntimeAuthority({
        provider: 'rest',
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
        authentication: {
          strategy: 'jwt',
          accessToken,
          payload: {
            ...taskPayload,
            sub: 'user-1',
            tenant_id: 'tenant-a',
          },
        },
      } as Params)
    ).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      branchId: 'branch-1',
      tokenFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('fails closed on wrong tenant projection, missing Branch, or absent authenticated bearer', () => {
    const base = {
      provider: 'rest',
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      authentication: {
        strategy: 'jwt',
        accessToken: 'verified-task-bearer',
        payload: { ...taskPayload, sub: 'user-1', tenant_id: 'tenant-a' },
      },
    };
    expect(
      authenticatedTaskExecutorRuntimeAuthority({
        ...base,
        tenant: { tenant_id: 'tenant-b', source: 'auth_claim' },
      } as Params)
    ).toBeNull();
    expect(
      authenticatedTaskExecutorRuntimeAuthority({
        ...base,
        authentication: {
          ...base.authentication,
          payload: { ...base.authentication.payload, branch_id: undefined },
        },
      } as Params)
    ).toBeNull();
    expect(
      authenticatedTaskExecutorRuntimeAuthority({
        ...base,
        authentication: { ...base.authentication, accessToken: undefined },
      } as Params)
    ).toBeNull();
  });

  it('distinguishes taskless command delegation from task-executor context', () => {
    const command = params({
      type: 'executor-session',
      purpose: 'executor-command',
      session_id: 'branch-clean',
      branch_id: 'branch-1',
    });

    expect(authenticatedTaskExecutorRuntimeScope(command)).toBeNull();
    expect(authenticatedExecutorCommandRuntimeScope(command)).toEqual({
      commandId: 'branch-clean',
      branchId: 'branch-1',
    });
    expect(matchesExecutorCommandRuntimeScope(command, 'branch-clean', 'branch-1')).toBe(true);
    expect(matchesExecutorCommandRuntimeScope(command, 'branch-clean', 'branch-other')).toBe(false);
    expect(matchesExecutorCommandRuntimeScope(params(), 'branch-clean', 'branch-1')).toBe(false);

    expect(
      authenticatedExecutorCommandRuntimeScope(
        params({
          type: 'executor-session',
          purpose: 'executor-task',
          session_id: 'branch-clean',
          branch_id: 'branch-1',
        })
      )
    ).toBeNull();
    expect(
      authenticatedTaskExecutorRuntimeScope(
        params({
          type: 'executor-session',
          purpose: 'executor-command',
          session_id: 'session-1',
          task_id: 'task-1',
          branch_id: 'branch-1',
        })
      )
    ).toBeNull();
  });

  it('exposes exact task context only for a complete task lease', () => {
    expect(authenticatedTaskExecutorRuntimeScope(params())).toEqual({
      sessionId: 'session-1',
      taskId: 'task-1',
      branchId: 'branch-1',
    });
    expect(isTaskScopedExecutorRequest(context(), 'task-1')).toBe(true);
    expect(isTaskScopedExecutorRequest(context(), 'task-other')).toBe(false);
    expect(
      matchesTaskExecutorRuntimeScope(authenticatedTaskExecutorRuntimeScope(params()), {
        task_id: 'task-1',
        session_id: 'session-1',
      })
    ).toBe(true);
    expect(
      matchesTaskExecutorRuntimeScope(authenticatedTaskExecutorRuntimeScope(params()), {
        task_id: 'task-1',
        session_id: 'session-other',
      })
    ).toBe(false);
    expect(executorRuntimeScopeSessionId(context())).toBe('session-1');
  });
});

describe('requireTaskScopedExecutorRuntimeToken', () => {
  const guard = requireTaskScopedExecutorRuntimeToken();

  it('accepts the exact task from custom-method data', async () => {
    const ctx = context();
    await expect(guard(ctx)).resolves.toBe(ctx);
  });

  it('accepts the exact task from installed custom-method arguments', async () => {
    const ctx = context({ data: undefined }) as HookContext & { arguments: unknown[] };
    ctx.arguments = [{ task_id: 'task-1' }];
    await expect(guard(ctx)).resolves.toBe(ctx);
  });

  it.each([
    ['ordinary user', { authentication: { strategy: 'jwt', payload: { sub: 'user-1' } } }],
    [
      'taskless command',
      params({
        type: 'executor-session',
        purpose: 'executor-command',
        session_id: 'branch-clean',
        branch_id: 'branch-1',
      }),
    ],
    ['another task', params()],
  ])('rejects %s authority', async (label, requestParams) => {
    const ctx = context({
      data: { task_id: label === 'another task' ? 'task-other' : 'task-1' },
      params: requestParams as Params,
    });
    await expect(guard(ctx)).rejects.toThrow(/scoped to this executor task/);
  });
});
