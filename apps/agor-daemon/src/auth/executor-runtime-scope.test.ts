import type { HookContext } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { SessionTokenService } from '../services/session-token-service';
import { createServiceToken } from '../utils/spawn-executor';
import {
  executorRuntimeScopeGuard,
  executorServiceCapabilityGuard,
  isBranchFilesystemLifecycleExecutorRequest,
  requireExecutorRuntimeToken,
  scopeExecutorRuntimeAuth,
} from './executor-runtime-scope';

function serviceCtx(
  command: string,
  overrides: Partial<HookContext>,
  claims: Record<string, unknown> = {}
): HookContext {
  return {
    path: 'branches',
    method: 'get',
    id: 'branch-1',
    app: { service: () => ({}) },
    params: {
      provider: 'socketio',
      query: {},
      authentication: {
        payload: {
          type: 'service',
          sub: 'executor-service',
          purpose: 'executor-service',
          role: 'service',
          command,
          ...claims,
        },
      },
    },
    ...overrides,
  } as HookContext;
}

describe('executor service command capabilities', () => {
  it('allows branch deletion to inventory tenant rows and read only its exact repo', async () => {
    const guard = executorServiceCapabilityGuard();
    await expect(
      guard(
        serviceCtx(
          'git.branch.remove',
          { path: 'branches', method: 'find', id: null },
          { branch_id: 'branch-1', repo_id: 'repo-1' }
        )
      )
    ).resolves.toBeDefined();
    await expect(
      guard(
        serviceCtx(
          'git.branch.remove',
          { path: 'repos', method: 'find', id: null },
          { branch_id: 'branch-1', repo_id: 'repo-1' }
        )
      )
    ).resolves.toBeDefined();
    await expect(
      guard(
        serviceCtx(
          'git.branch.remove',
          { path: 'repos', method: 'get', id: 'repo-2' },
          { branch_id: 'branch-1', repo_id: 'repo-1' }
        )
      )
    ).rejects.toThrow(/not valid/i);
  });

  it('allows repository deletion a read-only overlap inventory, not cross-repo mutation', async () => {
    const guard = executorServiceCapabilityGuard();
    const claims = { repo_id: 'repo-1', filesystem_operation_id: 'operation-1' };
    await expect(
      guard(serviceCtx('git.repo.delete', { path: 'branches', method: 'find', id: null }, claims))
    ).resolves.toBeDefined();
    await expect(
      guard(serviceCtx('git.repo.delete', { path: 'repos', method: 'find', id: null }, claims))
    ).resolves.toBeDefined();
    await expect(
      guard(
        serviceCtx(
          'git.repo.delete',
          { path: 'repos', method: 'patch', id: 'repo-2', data: { name: 'changed' } },
          claims
        )
      )
    ).rejects.toThrow(/not valid/i);
  });

  it('denies deletion credentials access to user credentials and unrelated services', async () => {
    const guard = executorServiceCapabilityGuard();
    const claims = { branch_id: 'branch-1', repo_id: 'repo-1' };
    await expect(
      guard(
        serviceCtx(
          'git.branch.remove',
          {
            path: 'users',
            method: 'getGitEnvironment',
            id: null,
            data: { userId: 'victim-user' },
          },
          claims
        )
      )
    ).rejects.toThrow(/not valid/i);
    await expect(
      guard(serviceCtx('git.branch.remove', { path: 'boards', method: 'find', id: null }, claims))
    ).rejects.toThrow(/not valid/i);
  });

  it('binds credential reads to a signed user and clone command', async () => {
    const guard = executorServiceCapabilityGuard();
    await expect(
      guard(
        serviceCtx(
          'git.clone',
          {
            path: 'users',
            method: 'getGitEnvironment',
            id: null,
            data: { userId: 'user-1' },
          },
          { repo_id: 'repo-1', user_id: 'user-1' }
        )
      )
    ).resolves.toBeDefined();
    await expect(
      guard(
        serviceCtx(
          'git.clone',
          {
            path: 'users',
            method: 'getGitEnvironment',
            id: null,
            data: { userId: 'user-2' },
          },
          { repo_id: 'repo-1', user_id: 'user-1' }
        )
      )
    ).rejects.toThrow(/not valid/i);
    await expect(
      guard(
        serviceCtx(
          'git.clone',
          { path: 'users', method: 'get', id: 'user-1' },
          {
            repo_id: 'repo-1',
            user_id: 'user-1',
          }
        )
      )
    ).resolves.toBeDefined();
    await expect(
      guard(
        serviceCtx(
          'git.clone',
          { path: 'users', method: 'get', id: 'user-2' },
          {
            repo_id: 'repo-1',
            user_id: 'user-1',
          }
        )
      )
    ).rejects.toThrow(/not valid/i);
  });

  it('rejects unscoped and unknown full service tokens', async () => {
    await expect(
      executorServiceCapabilityGuard()(
        serviceCtx('unknown.command', { path: 'branches', method: 'get', id: 'branch-1' })
      )
    ).rejects.toThrow(/recognized command/i);
  });
});

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

function lifecycleCtx(authenticationPayload: Record<string, unknown>): HookContext {
  return {
    path: 'branches',
    method: 'patch',
    id: 'branch-1',
    data: { filesystem_status: 'ready' },
    params: {
      authentication: { payload: authenticationPayload },
      provider: 'socketio',
      query: {},
    },
  } as HookContext;
}

describe('branch filesystem lifecycle executor scope', () => {
  const secret = 'branch-filesystem-lifecycle-test-secret';

  it.each(['branch-delete', 'branch-remove'])('accepts the actual %s token shape', async (kind) => {
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: 1 },
      { startCleanupTimer: false }
    );
    service.setJwtSecret(secret);
    const token = await service.generateToken(kind, 'user-1', {
      branchId: 'branch-1',
      filesystemOperationId: '019ffe00-0000-7000-8000-000000000099',
      maxUses: -1,
    });
    const decoded = jwt.decode(token) as Record<string, unknown>;

    expect(isBranchFilesystemLifecycleExecutorRequest(lifecycleCtx(decoded), 'branch-1')).toBe(
      true
    );
  });

  it('accepts the actual branch creation service-token shape', () => {
    const token = createServiceToken(secret, '5m', {
      command: 'git.branch.add',
      branch_id: 'branch-1',
      filesystem_operation_id: '019ffe00-0000-7000-8000-000000000099',
    });
    const decoded = jwt.decode(token) as Record<string, unknown>;

    expect(isBranchFilesystemLifecycleExecutorRequest(lifecycleCtx(decoded), 'branch-1')).toBe(
      true
    );
  });

  it('rejects lifecycle credentials that are not bound to an operation generation', async () => {
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: 1 },
      { startCleanupTimer: false }
    );
    service.setJwtSecret(secret);
    const deleteToken = await service.generateToken('branch-delete', 'user-1', {
      branchId: 'branch-1',
      maxUses: -1,
    });
    const createToken = createServiceToken(secret, '5m', {
      command: 'git.branch.add',
      branch_id: 'branch-1',
    });

    expect(
      isBranchFilesystemLifecycleExecutorRequest(
        lifecycleCtx(jwt.decode(deleteToken) as Record<string, unknown>),
        'branch-1'
      )
    ).toBe(false);
    expect(
      isBranchFilesystemLifecycleExecutorRequest(
        lifecycleCtx(jwt.decode(createToken) as Record<string, unknown>),
        'branch-1'
      )
    ).toBe(false);
  });

  it('rejects an actual ordinary task token even on the same branch', async () => {
    const service = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: 1 },
      { startCleanupTimer: false }
    );
    service.setJwtSecret(secret);
    const token = await service.generateToken('019ffe00-0000-7000-8000-000000000001', 'user-1', {
      taskId: '019ffe00-0000-7000-8000-000000000002',
      branchId: 'branch-1',
    });
    const decoded = jwt.decode(token) as Record<string, unknown>;

    expect(isBranchFilesystemLifecycleExecutorRequest(lifecycleCtx(decoded), 'branch-1')).toBe(
      false
    );
  });
});

describe('executorRuntimeScopeGuard', () => {
  it.each([
    'connectExecutor',
    'reportTerminationComplete',
    'reportRuntimeTelemetry',
    'reportSdkHealthFailure',
  ])('accepts scoped %s and rejects a different task', async (method) => {
    const context = ctx({ path: 'tasks', method, data: { task_id: 'task-1' } });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
    await expect(
      executorRuntimeScopeGuard()(ctx({ path: 'tasks', method, data: { task_id: 'task-2' } }))
    ).rejects.toThrow(/task scope/);
  });

  it('requires an executor token for the executor connection method', async () => {
    const context = ctx({
      method: 'connectExecutor',
      data: { task_id: 'task-1' },
      params: { provider: 'socketio', query: {}, user: { user_id: 'user-1' } },
    });

    await expect(requireExecutorRuntimeToken()(context)).rejects.toThrow(/executor token/);
  });

  it('allows a patch only for the executor token task', async () => {
    const matching = ctx({ method: 'patch', id: 'task-1', data: { status: 'running' } });
    const otherTask = ctx({ method: 'patch', id: 'task-2', data: { status: 'running' } });

    await expect(executorRuntimeScopeGuard()(matching)).resolves.toBe(matching);
    await expect(executorRuntimeScopeGuard()(otherTask)).rejects.toThrow(/task scope/);
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

  it('allows get only for the repo resolved from the token-scoped branch', async () => {
    const context = ctx({
      path: 'repos',
      method: 'get',
      id: 'repo-1',
      app: {
        service: (path: string) => {
          expect(path).toBe('branches');
          return {
            get: async (branchId: string, params: HookContext['params']) => {
              expect(branchId).toBe('branch-1');
              expect(params.provider).toBeUndefined();
              return { branch_id: branchId, repo_id: 'repo-1' };
            },
          };
        },
      } as HookContext['app'],
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it('preserves tenant context and rejects a repo outside the token branch', async () => {
    const context = ctx({
      path: 'repos',
      method: 'get',
      id: 'tenant-b-repo',
      params: {
        authentication: { payload },
        query: {},
        provider: 'socketio',
        tenant: { tenant_id: 'tenant-a' },
      },
      app: {
        service: () => ({
          get: async (_branchId: string, params: HookContext['params']) => {
            expect(params.tenant?.tenant_id).toBe('tenant-a');
            return { branch_id: 'branch-1', repo_id: 'tenant-a-repo' };
          },
        }),
      } as HookContext['app'],
    });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(/repo scope/);
  });

  it.each(['find', 'create', 'patch', 'remove'])(
    'rejects executor tokens for repos.%s',
    async (method) => {
      const context = ctx({ path: 'repos', method, id: method === 'find' ? undefined : 'repo-1' });

      await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(
        /not valid for this endpoint/
      );
    }
  );

  it('rejects executor tokens on unrecognized endpoints', async () => {
    const context = ctx({ path: 'unknown', method: 'find' });

    await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(
      /not valid for this endpoint/
    );
  });

  it.each(['opencode-auth', 'opencode-models'])('rejects executor tokens on %s', async (path) => {
    await expect(executorRuntimeScopeGuard()(ctx({ path, method: 'find' }))).rejects.toThrow(
      /not valid for this endpoint/
    );
  });

  it('allows OAuth auth-header hydration create to reach its session-token validation', async () => {
    const context = ctx({
      path: 'mcp-servers/oauth-auth-headers',
      method: 'create',
      data: { mcp_server_ids: ['server-1'], executorSessionToken: 'executor-token' },
    });

    await expect(executorRuntimeScopeGuard()(context)).resolves.toBe(context);
  });

  it.each(['find', 'get', 'patch', 'remove'])(
    'still blocks OAuth auth-header hydration %s',
    async (method) => {
      const context = ctx({ path: 'mcp-servers/oauth-auth-headers', method });

      await expect(executorRuntimeScopeGuard()(context)).rejects.toThrow(
        /not valid for this endpoint/
      );
    }
  );

  it('still blocks other MCP server endpoints', async () => {
    const context = ctx({ path: 'mcp-servers', method: 'find' });

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
        session_id: 'session-1',
        branch_id: 'branch-1',
        query: {},
        provider: 'socketio',
      } as never,
    });

    await executorRuntimeScopeGuard()(context);

    expect(context.data).toMatchObject({ taskId: 'task-1' });
  });

  it('does not treat ordinary JWT payloads with transport fields as executor scope', async () => {
    const context = ctx({
      method: 'patch',
      id: 'task-1',
      data: { status: 'completed' },
      params: {
        authentication: { strategy: 'jwt', payload: { type: 'access' } },
        task_id: 'task-1',
        query: {},
        provider: 'socketio',
      } as never,
    });

    await expect(requireExecutorRuntimeToken()(context)).rejects.toThrow(/executor token/);
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
