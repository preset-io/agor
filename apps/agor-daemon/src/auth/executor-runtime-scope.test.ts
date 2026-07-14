import type { HookContext } from '@agor/core/types';
import {
  EXECUTOR_CLEANUP_STATUS,
  EXECUTOR_STATE_PERSISTENCE_REQUIREMENT,
  EXECUTOR_STATE_PERSISTENCE_STATUS,
  TaskStatus,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  executorRuntimeScopeGuard,
  requireExecutorRuntimeToken,
  scopeExecutorRuntimeAuth,
} from './executor-runtime-scope';

const payload = {
  type: 'executor-session',
  purpose: 'executor-task',
  session_id: 'session-1',
  task_id: 'task-1',
  executor_attempt_id: 'attempt-1',
  branch_id: 'branch-1',
};

function ctx(overrides: Partial<HookContext>): HookContext {
  return {
    app: {
      service: (path: string) => ({
        get: async () =>
          path === 'sessions'
            ? { session_id: 'session-1', tasks: ['task-1'] }
            : {
                task_id: 'task-1',
                session_id: 'session-1',
                executor_attempt_id: 'attempt-1',
              },
      }),
    },
    path: 'tasks',
    method: 'find',
    params: { authentication: { payload }, query: {}, provider: 'socketio' },
    ...overrides,
  } as HookContext;
}

describe('executorRuntimeScopeGuard', () => {
  it('accepts the scoped executor connection method and rejects a different task', async () => {
    const context = ctx({
      path: 'tasks',
      method: 'connectExecutor',
      data: { task_id: 'task-1', executor_attempt_id: 'attempt-1' },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
    await expect(
      executorRuntimeScopeGuard()(
        ctx({
          path: 'tasks',
          method: 'connectExecutor',
          data: { task_id: 'task-2', executor_attempt_id: 'attempt-1' },
        })
      )
    ).rejects.toThrow(/task scope/);
  });

  it('requires the request attempt to match the executor token', async () => {
    const matching = ctx({
      method: 'connectExecutor',
      data: { task_id: 'task-1', executor_attempt_id: 'attempt-1' },
    });
    const stale = ctx({
      method: 'connectExecutor',
      data: { task_id: 'task-1', executor_attempt_id: 'attempt-old' },
    });

    await expect(requireExecutorRuntimeToken()(matching)).resolves.toBe(matching);
    await expect(requireExecutorRuntimeToken()(stale)).rejects.toThrow(/attempt scope/);
  });

  it('requires an executor token for the executor connection method', async () => {
    const context = ctx({
      method: 'connectExecutor',
      data: { task_id: 'task-1' },
      params: { provider: 'socketio', query: {}, user: { user_id: 'user-1' } },
    });

    await expect(requireExecutorRuntimeToken()(context)).rejects.toThrow(/executor token/);
  });

  it('scopes executor telemetry to the token task', async () => {
    const matching = ctx({
      path: 'tasks',
      method: 'reportExecutorTelemetry',
      data: {
        task_id: 'task-1',
        executor_attempt_id: 'attempt-1',
        heartbeat: true,
      },
    });
    const otherTask = ctx({
      path: 'tasks',
      method: 'reportExecutorTelemetry',
      data: {
        task_id: 'task-2',
        executor_attempt_id: 'attempt-1',
        heartbeat: true,
      },
    });

    await expect(executorRuntimeScopeGuard()(matching)).resolves.toBe(matching);
    await expect(executorRuntimeScopeGuard()(otherTask)).rejects.toThrow(/task scope/);
  });

  it('allows a patch only for the executor token task', async () => {
    const matching = ctx({ method: 'patch', id: 'task-1', data: { status: 'running' } });
    const otherTask = ctx({ method: 'patch', id: 'task-2', data: { status: 'running' } });

    await expect(executorRuntimeScopeGuard()(matching)).resolves.toBe(matching);
    await expect(executorRuntimeScopeGuard()(otherTask)).rejects.toThrow(/task scope/);
  });

  it.each([
    ['sessions', 'update', 'session-1'],
    ['sessions', 'remove', 'session-1'],
    ['tasks', 'update', 'task-1'],
    ['tasks', 'remove', 'task-1'],
    ['branches', 'patch', 'branch-1'],
    ['branches', 'remove', 'branch-1'],
  ] as const)('rejects task-scoped executor %s.%s calls', async (path, method, id) => {
    const context = ctx({ path, method, id, data: {} });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/task token is not valid/);
  });

  it('preserves branch mutations for non-task executor command tokens', async () => {
    const commandPayload = {
      type: 'executor-session',
      purpose: 'executor-task',
      session_id: 'branch-clean',
      branch_id: 'branch-1',
    };
    const context = ctx({
      path: 'branches',
      method: 'patch',
      id: 'branch-1',
      data: { filesystem_status: 'ready' },
      params: {
        authentication: { payload: commandPayload },
        query: {},
        provider: 'socketio',
      },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it('rejects ordinary mutations from a stale executor attempt', async () => {
    const context = ctx({
      method: 'patch',
      id: 'task-1',
      data: { status: 'failed' },
      app: {
        service: () => ({
          get: async () => ({
            task_id: 'task-1',
            executor_attempt_id: 'attempt-current',
          }),
        }),
      } as never,
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/executor attempt scope/);
  });

  it.each([
    { path: 'tasks', method: 'patch', id: 'task-1', data: { report: 'late write' } },
    {
      path: 'messages',
      method: 'create',
      data: { task_id: 'task-1', session_id: 'session-1' },
    },
  ])('rejects late $path mutations after finalization releases', async (request) => {
    const context = ctx({
      ...request,
      app: {
        service: () => ({
          get: async () => ({
            task_id: 'task-1',
            executor_attempt_id: 'attempt-1',
            status: TaskStatus.STOPPED,
            executor_finalization: {
              cleanup_status: EXECUTOR_CLEANUP_STATUS.VERIFIED,
              state_persistence_status: EXECUTOR_STATE_PERSISTENCE_STATUS.SKIPPED,
              state_persistence_requirement: EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.NOT_REQUIRED,
            },
          }),
        }),
      } as never,
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/already finalized/);
  });

  it('rejects session mutations from a task that is no longer latest', async () => {
    const context = ctx({
      path: 'sessions',
      method: 'patch',
      id: 'session-1',
      data: { status: 'running' },
      app: {
        service: (path: string) => ({
          get: async () =>
            path === 'sessions'
              ? { session_id: 'session-1', tasks: ['task-1', 'task-current'] }
              : {
                  task_id: 'task-1',
                  session_id: 'session-1',
                  executor_attempt_id: 'attempt-1',
                },
        }),
      } as never,
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/latest session task scope/);
  });

  it.each([
    { status: 'idle' },
    { status: 'timed_out', ready_for_prompt: true },
    { ready_for_prompt: true },
  ])('reserves terminal session settlement for the daemon: %j', async (data) => {
    await expect(
      executorRuntimeScopeGuard()(ctx({ path: 'sessions', method: 'patch', id: 'session-1', data }))
    ).rejects.toThrow(/cannot (release|settle) sessions/);
  });

  it.each([
    'running',
    'awaiting_permission',
    'awaiting_input',
  ])('allows the executor to report transient session status %s', async (status) => {
    const context = ctx({
      path: 'sessions',
      method: 'patch',
      id: 'session-1',
      data: { status },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it.each([
    ['sessions', 'session-1', { name: 'forged' }],
    ['tasks', 'task-1', { full_prompt: 'forged' }],
  ] as const)('rejects unrelated task-token writes to %s', async (path, id, data) => {
    await expect(
      executorRuntimeScopeGuard()(ctx({ path, method: 'patch', id, data }))
    ).rejects.toThrow(/cannot patch/);
  });

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

  it('wraps auth hooks and allows task-scoped API key resolution', async () => {
    const requireAuth = async (context: HookContext) => context;
    const context = ctx({
      path: 'config/resolve-api-key',
      method: 'create',
      data: { keyName: 'OPENAI_API_KEY', tool: 'codex' },
    });

    await expect(scopeExecutorRuntimeAuth(requireAuth)(context)).resolves.toBe(context);
    expect(context.data).toMatchObject({ taskId: 'task-1' });
  });

  it('uses JWT auth-result scope fields when Socket.io drops the decoded payload', async () => {
    const context = ctx({
      path: 'config/resolve-api-key',
      method: 'create',
      data: { keyName: 'OPENAI_API_KEY', tool: 'codex' },
      params: {
        authentication: { strategy: 'jwt' },
        task_id: 'task-1',
        executor_attempt_id: 'attempt-1',
        session_id: 'session-1',
        branch_id: 'branch-1',
        query: {},
        provider: 'socketio',
      } as never,
    });

    await executorRuntimeScopeGuard()(context);

    expect(context.data).toMatchObject({ taskId: 'task-1' });
  });

  it('rejects API key resolution for another task under executor token auth', async () => {
    const context = ctx({
      path: 'config/resolve-api-key',
      method: 'create',
      data: { taskId: 'task-2', keyName: 'OPENAI_API_KEY', tool: 'codex' },
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/task scope/);
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
