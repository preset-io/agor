import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { executorRuntimeScopeGuard } from './executor-runtime-scope';

const payload = {
  type: 'executor-session',
  purpose: 'executor-task',
  session_id: 'session-1',
  task_id: 'task-1',
  branch_id: 'branch-1',
};

function ctx(overrides: Partial<HookContext>): HookContext {
  return {
    path: 'tasks',
    method: 'find',
    params: { authentication: { payload }, query: {} },
    ...overrides,
  } as HookContext;
}

describe('executorRuntimeScopeGuard', () => {
  it('narrows find queries to executor token scope', async () => {
    const context = ctx({ path: 'messages', method: 'find' });

    await executorRuntimeScopeGuard()(context);

    expect(context.params.query).toMatchObject({
      task_id: 'task-1',
      session_id: 'session-1',
    });
  });

  it('rejects find queries that request a different scoped object', async () => {
    const context = ctx({
      path: 'tasks',
      method: 'find',
      params: { authentication: { payload }, query: { task_id: 'task-2' } },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/task scope/);
  });

  it('rejects task/message services when token has no task scope', async () => {
    const context = ctx({
      path: 'messages',
      method: 'find',
      params: {
        authentication: {
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            session_id: 'branch-clean',
            branch_id: 'branch-1',
          },
        },
        query: {},
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/missing task scope/);
  });

  it('narrows branch find queries to branch scope', async () => {
    const context = ctx({ path: 'branches', method: 'find' });

    await executorRuntimeScopeGuard()(context);

    expect(context.params.query).toMatchObject({ branch_id: 'branch-1' });
  });

  it('rejects message get by opaque message id under executor token auth', async () => {
    const context = ctx({ path: 'messages', method: 'get', id: 'message-1' });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/messages request/);
  });
});
