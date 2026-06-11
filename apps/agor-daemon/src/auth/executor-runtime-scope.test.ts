import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { executorRuntimeScopeGuard, scopeExecutorRuntimeAuth } from './executor-runtime-scope';

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
    params: { authentication: { payload }, query: {}, provider: 'socketio' },
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

  it('allows session-wide message history reads for the scoped session', async () => {
    const context = ctx({
      path: 'messages',
      method: 'find',
      params: {
        authentication: { payload },
        query: { session_id: 'session-1' },
        provider: 'socketio',
      },
    });

    await executorRuntimeScopeGuard()(context);

    expect(context.params.query).toEqual({ session_id: 'session-1' });
  });

  it('rejects session-wide message reads for another session', async () => {
    const context = ctx({
      path: 'messages',
      method: 'find',
      params: {
        authentication: { payload },
        query: { session_id: 'session-2' },
        provider: 'socketio',
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/session scope/);
  });

  it('keeps explicit message task reads scoped to the executor task', async () => {
    const context = ctx({
      path: 'messages',
      method: 'find',
      params: { authentication: { payload }, query: { task_id: 'task-1' }, provider: 'socketio' },
    });

    await executorRuntimeScopeGuard()(context);

    expect(context.params.query).toEqual({ task_id: 'task-1', session_id: 'session-1' });
  });

  it('rejects find queries that request a different scoped object', async () => {
    const context = ctx({
      path: 'tasks',
      method: 'find',
      params: { authentication: { payload }, query: { task_id: 'task-2' }, provider: 'socketio' },
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
        provider: 'socketio',
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/missing task scope/);
  });

  it('narrows branch find queries to branch scope', async () => {
    const context = ctx({ path: 'branches', method: 'find' });

    await executorRuntimeScopeGuard()(context);

    expect(context.params.query).toMatchObject({ branch_id: 'branch-1' });
  });

  it('allows message get when the existing message belongs to the scoped session', async () => {
    const context = ctx({
      path: 'messages',
      method: 'get',
      id: 'message-1',
      service: {
        findByIdForScopeCheck: async () => ({
          message_id: 'message-1',
          task_id: 'previous-task',
          session_id: 'session-1',
        }),
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it('rejects message get when the existing message belongs to another session', async () => {
    const context = ctx({
      path: 'messages',
      method: 'get',
      id: 'message-1',
      service: {
        findByIdForScopeCheck: async () => ({
          message_id: 'message-1',
          task_id: 'task-1',
          session_id: 'session-2',
        }),
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/session scope/);
  });

  it('allows message patch when the existing message belongs to the scoped task', async () => {
    const context = ctx({
      path: 'messages',
      method: 'patch',
      id: 'message-1',
      data: { content_preview: 'done' },
      service: {
        findByIdForScopeCheck: async () => ({
          message_id: 'message-1',
          task_id: 'task-1',
          session_id: 'session-1',
        }),
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it('rejects message patch when the existing message belongs to another task', async () => {
    const context = ctx({
      path: 'messages',
      method: 'patch',
      id: 'message-1',
      data: { content_preview: 'done' },
      service: {
        findByIdForScopeCheck: async () => ({
          message_id: 'message-1',
          task_id: 'task-2',
          session_id: 'session-1',
        }),
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/task scope/);
  });

  it('rejects message patch when the existing message has no task scope', async () => {
    const context = ctx({
      path: 'messages',
      method: 'patch',
      id: 'message-1',
      data: { content_preview: 'done' },
      service: {
        findByIdForScopeCheck: async () => ({
          message_id: 'message-1',
          session_id: 'session-1',
        }),
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/task scope/);
  });

  it('rejects executor tokens on unrecognized endpoints', async () => {
    const context = ctx({ path: 'repos', method: 'find' });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(
      /not valid for this endpoint/
    );
  });

  it('bypasses internal (provider-less) service composition', async () => {
    // Route handlers the executor legitimately reaches fan out to non-allowlisted
    // services internally (e.g. sessions/:id/mcp-servers reading `mcp-servers`).
    // Those internal calls carry the executor payload but have no transport
    // provider and must not be re-scoped/rejected.
    const context = ctx({
      path: 'mcp-servers',
      method: 'find',
      params: { authentication: { payload }, query: {} },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it('validates every bulk message payload item against task scope', async () => {
    const context = ctx({
      path: 'messages/bulk',
      method: 'create',
      data: [
        { message_id: 'message-1', task_id: 'task-1', session_id: 'session-1' },
        { message_id: 'message-2' },
      ],
    });

    await executorRuntimeScopeGuard()(context);

    expect(context.data).toEqual([
      { message_id: 'message-1', task_id: 'task-1', session_id: 'session-1' },
      { message_id: 'message-2', task_id: 'task-1', session_id: 'session-1' },
    ]);
  });

  it('rejects bulk message payloads for another task', async () => {
    const context = ctx({
      path: 'messages/bulk',
      method: 'create',
      data: [{ message_id: 'message-1', task_id: 'task-2', session_id: 'session-1' }],
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/task scope/);
  });

  it('validates streaming event payload scope', async () => {
    const context = ctx({
      path: 'tasks/streaming',
      method: 'create',
      data: {
        event: 'thinking:chunk',
        data: { task_id: 'task-1', session_id: 'session-1', text: 'chunk' },
      },
    });

    await executorRuntimeScopeGuard()(context);

    expect((context.data as { data: Record<string, unknown> }).data).toMatchObject({
      task_id: 'task-1',
      session_id: 'session-1',
    });
  });

  it('rejects streaming events for another session', async () => {
    const context = ctx({
      path: 'messages/streaming',
      method: 'create',
      data: {
        event: 'message:chunk',
        data: { task_id: 'task-1', session_id: 'session-2' },
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/session scope/);
  });

  it('allows scoped session genealogy route only for the scoped session', async () => {
    const context = ctx({
      path: 'sessions/:id/genealogy',
      method: 'find',
      params: {
        authentication: { payload },
        query: {},
        route: { id: 'session-1' },
        provider: 'socketio',
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it('rejects session custom routes that are not explicitly allowed', async () => {
    const context = ctx({
      path: 'sessions/:id/fork',
      method: 'create',
      params: {
        authentication: { payload },
        query: {},
        route: { id: 'session-1' },
        provider: 'socketio',
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(
      /not valid for this endpoint/
    );
  });

  it('allows scoped read-only session MCP server resolution', async () => {
    const context = ctx({
      path: 'sessions/:id/mcp-servers',
      method: 'find',
      params: {
        authentication: { payload },
        query: {},
        route: { id: 'session-1' },
        provider: 'socketio',
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it('rejects session MCP server writes under executor token auth', async () => {
    const context = ctx({
      path: 'sessions/:id/mcp-servers',
      method: 'create',
      params: {
        authentication: { payload },
        query: {},
        route: { id: 'session-1' },
        provider: 'socketio',
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(
      /not valid for this endpoint/
    );
  });

  it('rejects session MCP server reads for another session', async () => {
    const context = ctx({
      path: 'sessions/:id/mcp-servers',
      method: 'find',
      params: {
        authentication: { payload },
        query: {},
        route: { id: 'session-2' },
        provider: 'socketio',
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/session scope/);
  });

  it('wraps auth hooks with executor runtime scope validation', async () => {
    const requireAuth = async (context: HookContext) => context;
    const context = ctx({ path: 'config/resolve-api-key', method: 'create' });

    await expect(scopeExecutorRuntimeAuth(requireAuth)(context)).rejects.toThrow(
      /not valid for this endpoint/
    );
  });

  it('lets wrapped auth hooks pass internal (provider-less) service composition', async () => {
    // Mirrors the production failure: the externally-guarded
    // sessions/:id/mcp-servers handler fans out to the non-allowlisted
    // mcp-servers service with the executor payload but no transport provider.
    const requireAuth = async (context: HookContext) => context;
    const context = ctx({
      path: 'mcp-servers',
      method: 'find',
      params: { authentication: { payload }, query: {} },
    });

    await expect(scopeExecutorRuntimeAuth(requireAuth)(context)).resolves.toBe(context);
  });
});
