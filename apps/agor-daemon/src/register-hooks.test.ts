/**
 * Regression tests for hooks registered in register-hooks.ts.
 *
 * Covers the sessions.patch permission branching introduced to fix the bug
 * where a user with `session`-tier permission on a branch could not prompt
 * their own session because the /sessions/:id/prompt route issues an internal
 * `{ tasks: [...] }` patch that was being gated behind `all`-tier.
 *
 * The branching logic in register-hooks.ts looks like:
 *
 *   if (isPromptFlowPatchOnly(context.data)) {
 *     → ensureCanPromptInSession (session-tier for own, prompt-tier otherwise)
 *   } else {
 *     → ensureBranchPermission('all')   // metadata writes
 *   }
 *
 * The two downstream hooks are covered elsewhere (see
 * branch-authorization.test.ts), so here we only verify the classifier.
 */

import {
  BoardRepository,
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  runWithTenantContext,
} from '@agor/core/db';
import { type Branch, type HookContext, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTHENTICATED_RBAC_SERVICE_PATHS,
  CLAUDE_CREDENTIAL_WRITE_ADMISSION_SERVICE_PATHS,
  CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES,
  classifyPrimaryTeammateAuthorizationInvalidation,
  classifyRealtimeAuthorizationInvalidation,
  createTenantScopedBeforeHookChain,
  enrichSessionFindResultWithRemoteRelationships,
  getTrustedSessionTenantId,
  isPromptFlowPatchOnly,
  PROMPT_FLOW_PATCH_FIELDS,
  projectExecutorTaskSdkResponse,
  protectExternalBranchCrud,
  protectExternalTaskCreate,
  protectFilesystemHomeWrite,
  protectServerManagedTaskWrites,
  type RegisterHooksContext,
  registerHooks,
  shouldDrainQueueAfterSessionPostTurnPatch,
  shouldRunSessionPostTurnHooks,
  shouldValidateRepoEnvironmentPayload,
  TENANT_IDENTITY_ONLY_SERVICE_PATHS,
  TENANT_OWNED_SERVICE_PATHS,
  validateBranchEnvPolicyHook,
} from './register-hooks';
import { canReceiveMcpTokenForSession } from './utils/mcp-token-authorization';

const makeSession = (sessionId: string): import('@agor/core/types').Session =>
  ({
    session_id: sessionId,
    branch_id: 'branch-1',
    status: 'idle',
    agentic_tool: 'codex',
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-01T00:00:00.000Z',
    tasks: [],
    genealogy: { children: [] },
    contextFiles: [],
    scheduled_from_branch: false,
    ready_for_prompt: false,
    archived: false,
  }) as import('@agor/core/types').Session;

describe('classifyRealtimeAuthorizationInvalidation', () => {
  const classify = (path: string, method: HookContext['method'], data: unknown = {}) =>
    classifyRealtimeAuthorizationInvalidation({ path, method, data } as Pick<
      HookContext,
      'path' | 'method' | 'data'
    >);

  it.each([
    ['branches', { board_id: 'board-1' }],
    ['boards', { access_mode: 'private' }],
    ['users', { role: 'member' }],
    ['board-objects', { board_id: 'board-1', branch_id: 'branch-1' }],
    ['groups', { name: 'new group' }],
  ])('does not evict sockets while creating additive %s state', (path, data) => {
    expect(classify(path, 'create', data)).toBe('none');
  });

  it('evicts when group membership suppresses a potentially broader Others fallback', () => {
    expect(classify('group-memberships', 'create')).toBe('evict');
  });

  it.each([
    ['branches', 'patch', { board_id: 'board-2' }],
    ['branches', 'patch', { permission_binding: 'inherit' }],
    ['branches', 'remove', {}],
    ['boards', 'patch', { access_mode: 'private' }],
    ['boards', 'patch', { archived: true }],
    ['boards', 'patch', { default_others_fs_access: 'read' }],
    ['boards', 'remove', {}],
    ['users', 'patch', { role: 'suspended' }],
    ['users', 'patch', { must_change_password: true }],
    ['users', 'update', { must_change_password: false }],
    ['users', 'remove', {}],
    ['branches/:id/permissions', 'patch', {}],
    ['boards/:id/permissions', 'patch', {}],
    ['group-memberships', 'remove', {}],
    ['groups', 'patch', { archived: true }],
  ] as const)('evicts stale sockets for revoking %s.%s', (path, method, data) => {
    expect(classify(path, method, data)).toBe('evict');
  });

  it('ignores branch metadata patches that cannot change authorization', () => {
    expect(classify('branches', 'patch', { name: 'Renamed' })).toBe('none');
  });
});

describe('classifyPrimaryTeammateAuthorizationInvalidation', () => {
  const board = {
    board_id: 'board-1',
    primary_teammate_id: 'branch-1',
  } as const;

  it('uses cache-only invalidation when the prior primary remains attached', () => {
    expect(
      classifyPrimaryTeammateAuthorizationInvalidation(board, {
        branch_id: 'branch-1',
        board_id: 'board-1',
      })
    ).toBe('cache');
  });

  it('fully evicts when a detached primary could be the only visibility anchor', () => {
    expect(
      classifyPrimaryTeammateAuthorizationInvalidation(board, {
        branch_id: 'branch-1',
        board_id: 'board-2',
      })
    ).toBe('evict');
  });

  it('fails closed when the existing primary cannot be resolved', () => {
    expect(classifyPrimaryTeammateAuthorizationInvalidation(board, null)).toBe('evict');
  });

  it('does not evict for an initial assignment with no previous primary', () => {
    expect(
      classifyPrimaryTeammateAuthorizationInvalidation(
        { board_id: 'board-1', primary_teammate_id: null },
        null
      )
    ).toBe('cache');
  });
});

describe('registered primary-teammate invalidation lifecycle', () => {
  type PrimaryMethod = 'setPrimaryTeammate' | 'clearPrimaryTeammate';
  type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;
  type RegisteredHooks = {
    before?: Partial<Record<PrimaryMethod, RegisteredHook[]>>;
    after?: Partial<Record<PrimaryMethod, RegisteredHook[]>>;
  };

  const runInstalledPrimaryHooks = async (options: {
    method: PrimaryMethod;
    previousBoardId: string | null;
  }) => {
    const registrations: RegisteredHooks[] = [];
    const emit = vi.fn();
    const service = {
      hooks(hooks: RegisteredHooks) {
        registrations.push(hooks);
      },
      emit: vi.fn(),
    };
    const app = {
      service(path: string) {
        if (path.replace(/^\//, '') === 'boards') return service;
        return { hooks() {}, emit: vi.fn() };
      },
      use() {},
      publish() {},
      emit,
    };
    const board = {
      board_id: 'board-1',
      primary_teammate_id: 'branch-old',
    } as const;
    const findBoard = vi
      .spyOn(BoardRepository.prototype, 'findBySlugOrId')
      .mockResolvedValue(board as never);
    const branchRepository = {
      findById: vi.fn(async () => ({
        branch_id: 'branch-old',
        board_id: options.previousBoardId,
      })),
    };

    try {
      registerHooks({
        db: {} as RegisterHooksContext['db'],
        app: app as RegisterHooksContext['app'],
        config: {
          database: { dialect: 'sqlite' },
          multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
          execution: { branch_rbac: false },
        } as RegisterHooksContext['config'],
        jwtSecret: 'registration-test-secret',
        requireAuth: async (context) => context,
        superadminOpts: { allowSuperadmin: true },
        sessionsService: {} as RegisterHooksContext['sessionsService'],
        messagesService: {} as RegisterHooksContext['messagesService'],
        boardsService: undefined,
        branchRepository: branchRepository as unknown as RegisterHooksContext['branchRepository'],
        usersRepository: {} as RegisterHooksContext['usersRepository'],
        sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
        deployment: { mode: 'standalone' },
      });

      const firstArgument =
        options.method === 'setPrimaryTeammate'
          ? { boardId: 'board-1', branchId: 'branch-new' }
          : 'board-1';
      const context = {
        path: 'boards',
        method: options.method,
        params: {
          tenant: { tenant_id: 'registration-test', source: 'static' },
          provider: 'socketio',
          user: { user_id: 'member-1', role: 'member' },
        },
        result: board,
        arguments: [firstArgument],
      } as unknown as HookContext;

      for (const registration of registrations) {
        for (const hook of registration.before?.[options.method] ?? []) await hook(context);
      }
      expect(findBoard).toHaveBeenCalledWith('board-1');
      expect(branchRepository.findById).toHaveBeenCalledWith('branch-old');
      expect(Object.getOwnPropertySymbols(context.params)).toHaveLength(1);

      for (const registration of registrations) {
        for (const hook of registration.after?.[options.method] ?? []) await hook(context);
      }
      await vi.waitFor(() =>
        expect(emit).toHaveBeenCalledWith('realtime:authorization-invalidated', {
          tenantId: 'registration-test',
          disconnectSockets: options.previousBoardId !== 'board-1',
        })
      );
    } finally {
      findBoard.mockRestore();
    }
  };

  it.each(['setPrimaryTeammate', 'clearPrimaryTeammate'] as const)(
    'keeps onboarding-safe cache invalidation across the installed %s hook chain',
    async (method) => {
      await runInstalledPrimaryHooks({ method, previousBoardId: 'board-1' });
    }
  );

  it.each(['setPrimaryTeammate', 'clearPrimaryTeammate'] as const)(
    'fully evicts a detached visibility anchor across the installed %s hook chain',
    async (method) => {
      await runInstalledPrimaryHooks({ method, previousBoardId: 'board-old' });
    }
  );
});

describe('protectFilesystemHomeWrite', () => {
  const config = { paths: { data_home: '/srv/agor-data' } };
  const context = (
    role: string | undefined,
    filesystem_home: unknown,
    provider: string | null = 'rest'
  ) =>
    ({
      data: { filesystem_home },
      params: {
        provider,
        user: role ? { user_id: 'user-1', role } : undefined,
      },
    }) as unknown as import('@agor/core/types').HookContext;

  it('rejects a member changing their own host home path', () => {
    expect(() => protectFilesystemHomeWrite(context('member', '/home/member'), config)).toThrow(
      'Only admins can modify filesystem_home'
    );
  });

  it('allows an admin to set a validated absolute path', () => {
    const hook = context('admin', '/home/member');
    expect(protectFilesystemHomeWrite(hook, config)).toBe(hook);
    expect(hook.data).toEqual({ filesystem_home: '/home/member' });
  });

  it('validates trusted internal writes against the effective data root', () => {
    expect(() =>
      protectFilesystemHomeWrite(context(undefined, '/srv/agor-data/tenants/t1', null), config)
    ).toThrow(/must not overlap/);
  });

  it('also rejects homes overlapping a configured external tenants base', () => {
    expect(() =>
      protectFilesystemHomeWrite(context('admin', '/mnt/tenants/tenant-a/homes/user-1'), {
        paths: { data_home: '/srv/agor-data' },
        multi_tenancy: {
          filesystem_isolation_enabled: true,
          tenants_base_folder: '/mnt/tenants',
        },
      })
    ).toThrow(/must not overlap/);
  });
});

describe('protectExternalTaskCreate', () => {
  const context = (data: unknown, provider: string | null = 'rest') =>
    ({ data, params: { provider } }) as import('@agor/core/types').HookContext;

  it('preserves the documented dormant create/run contract', () => {
    const hook = context({ session_id: 'session-1', full_prompt: 'hello' });
    expect(protectExternalTaskCreate(hook)).toBe(hook);
    expect(hook.data).toEqual({
      session_id: 'session-1',
      full_prompt: 'hello',
      status: TaskStatus.CREATED,
    });
  });

  it.each(['running', 'queued', 'completed'])('rejects externally forged status %s', (status) => {
    expect(() =>
      protectExternalTaskCreate(context({ session_id: 'session-1', full_prompt: 'hello', status }))
    ).toThrow('must use status created');
  });

  it('rejects lifecycle and identity fields outside the create contract', () => {
    expect(() =>
      protectExternalTaskCreate(
        context({ session_id: 'session-1', full_prompt: 'hello', created_by: 'forged' })
      )
    ).toThrow('not client-managed');
  });

  it('leaves trusted internal task creation unchanged', () => {
    const hook = context({ status: TaskStatus.RUNNING }, null);
    expect(protectExternalTaskCreate(hook)).toBe(hook);
    expect(hook.data).toEqual({ status: TaskStatus.RUNNING });
  });
});

describe('protectExternalBranchCrud', () => {
  const context = (
    data: unknown,
    options: {
      provider?: string | null;
      method?: 'create' | 'patch' | 'update';
      commandId?: string;
      branchId?: string;
    } = {}
  ) =>
    ({
      id: options.branchId ?? 'branch-1',
      method: options.method ?? 'patch',
      data,
      params: {
        provider: options.provider === undefined ? 'rest' : options.provider,
        user: { user_id: 'manager-1', role: 'admin' },
        ...(options.commandId
          ? {
              authentication: {
                strategy: 'jwt',
                payload: {
                  type: 'executor-session',
                  purpose: 'executor-command',
                  session_id: options.commandId,
                  branch_id: options.branchId ?? 'branch-1',
                },
              },
            }
          : {}),
      },
    }) as unknown as HookContext;

  it.each(['rest', 'socketio'])('rejects %s attempts to forge environment state', (provider) => {
    expect(() =>
      protectExternalBranchCrud(
        context(
          { environment_instance: { active_lifecycle_attempt: null, status: 'running' } },
          { provider }
        )
      )
    ).toThrow('server-managed: environment_instance');
  });

  it('rejects archive and filesystem state even for an administrator', () => {
    expect(() =>
      protectExternalBranchCrud(
        context({ archived: true, filesystem_status: 'deleted' }, { provider: 'rest' })
      )
    ).toThrow('server-managed: archived');
  });

  it('allows ordinary client-authored metadata and trusted internal writes', () => {
    const external = context({ notes: 'updated', board_id: 'board-2' });
    expect(protectExternalBranchCrud(external)).toBe(external);
    const internal = context(
      { environment_instance: { status: 'stopped' }, archived: true },
      { provider: null }
    );
    expect(protectExternalBranchCrud(internal)).toBe(internal);
  });

  it('keeps filesystem settlement out of generic CRUD even for an executor token', () => {
    expect(() =>
      protectExternalBranchCrud(
        context(
          { filesystem_status: 'ready' },
          { commandId: 'git.branch.add', branchId: 'branch-1' }
        )
      )
    ).toThrow('server-managed');
  });
});

describe('protectServerManagedTaskWrites', () => {
  const executorPayload = {
    type: 'executor-session',
    purpose: 'executor-task',
    session_id: 'session-1',
    task_id: 'task-1',
    branch_id: 'branch-1',
  };
  const externalContext = (
    method: 'patch',
    data: unknown,
    options: {
      taskId?: string;
      executorTaskId?: string;
    } = {}
  ): import('@agor/core/types').HookContext =>
    ({
      path: 'tasks',
      method,
      id: options.taskId,
      data,
      params: {
        provider: 'rest',
        ...(options.executorTaskId
          ? {
              authentication: {
                strategy: 'jwt',
                payload: { ...executorPayload, task_id: options.executorTaskId },
              },
            }
          : {}),
      },
    }) as import('@agor/core/types').HookContext;

  it('rejects every normal-user patch, including terminality', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext('patch', { status: TaskStatus.COMPLETED }, { taskId: 'task-1' })
      )
    ).rejects.toThrow('executor token scoped to this task');
  });

  it('rejects an executor token scoped to another task', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext(
          'patch',
          { status: TaskStatus.COMPLETED },
          { taskId: 'task-1', executorTaskId: 'task-2' }
        )
      )
    ).rejects.toThrow('executor token scoped to this task');
  });

  it.each(['task_id', 'session_id', 'created_by', 'queue_position', 'sdk_failure'])(
    'rejects executor patch field %s outside the result allowlist',
    async (field) => {
      await expect(
        protectServerManagedTaskWrites(
          externalContext(
            'patch',
            { [field]: 'forged' },
            {
              taskId: 'task-1',
              executorTaskId: 'task-1',
            }
          )
        )
      ).rejects.toThrow('not executor-managed');
    }
  );

  it('allows a task-scoped executor to publish bounded result fields', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext(
          'patch',
          {
            status: TaskStatus.COMPLETED,
            completed_at: '2026-07-10T20:00:00.000Z',
            model: 'test-model',
            git_state: { sha_at_end: 'abc' },
          },
          {
            taskId: 'task-1',
            executorTaskId: 'task-1',
          }
        )
      )
    ).resolves.toBeDefined();
  });

  it.each([TaskStatus.AWAITING_PERMISSION, TaskStatus.AWAITING_INPUT])(
    'allows a scoped executor to request resume from %s',
    async () => {
      const context = externalContext(
        'patch',
        { status: TaskStatus.RUNNING },
        {
          taskId: 'task-1',
          executorTaskId: 'task-1',
        }
      );

      await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
    }
  );

  it('preserves trusted internal direct-to-running task writes', async () => {
    const context = externalContext('patch', {
      status: TaskStatus.RUNNING,
    });
    context.params.provider = undefined;

    await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
  });

  it('preserves trusted internal dispatching task writes', async () => {
    const context = externalContext('patch', {
      status: TaskStatus.DISPATCHING,
    });
    context.params.provider = undefined;

    await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
  });
});

describe('projectExecutorTaskSdkResponse', () => {
  it('closes a normalized-only executor patch without touching extension getters', async () => {
    const sentinel = 'SENTINEL_NORMALIZED_ONLY_DAEMON_41a8';
    const getter = vi.fn(() => {
      throw new Error(sentinel);
    });
    const tokenUsage = Object.create({ provider_secret: sentinel }) as Record<string, unknown>;
    Object.assign(tokenUsage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    Object.defineProperty(tokenUsage, 'futureProviderField', { get: getter });
    const context = {
      path: 'tasks',
      method: 'patch',
      id: 'task-1',
      data: {
        normalized_sdk_response: {
          tokenUsage,
          contextWindowLimit: 100,
          contextUsageSnapshot: {
            totalTokens: 6,
            maxTokens: 100,
            percentage: 6,
            memoryFiles: [{ path: sentinel }],
          },
          extension: { secret: sentinel },
        },
      },
      params: { provider: 'socketio' },
    } as unknown as HookContext;
    const tasks = { findById: vi.fn() };
    const sessions = { findById: vi.fn() };

    await expect(projectExecutorTaskSdkResponse(tasks, sessions)(context)).resolves.toBe(context);

    expect(context.data).toEqual({
      normalized_sdk_response: {
        tokenUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        contextWindowLimit: 100,
        contextUsageSnapshot: { totalTokens: 6, maxTokens: 100, percentage: 6 },
      },
    });
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(context.data)).not.toContain(sentinel);
    expect(tasks.findById).not.toHaveBeenCalled();
    expect(sessions.findById).not.toHaveBeenCalled();
  });

  it('re-closes Claude result data before persistence and realtime publication', async () => {
    const sentinel = 'SENTINEL_DAEMON_RAW_CLAUDE_RESULT_6d31';
    const context = {
      path: 'tasks',
      method: 'patch',
      id: 'task-1',
      data: {
        raw_sdk_response: {
          type: 'result',
          subtype: 'success',
          result: sentinel,
          errors: [sentinel],
          duration_ms: 7,
          duration_api_ms: Number.POSITIVE_INFINITY,
          num_turns: 0,
          is_error: false,
          usage: { input_tokens: 3, provider_secret: sentinel },
          modelUsage: { [sentinel]: { inputTokens: 3 } },
        },
      },
      params: { provider: 'rest' },
    } as unknown as HookContext;
    const hook = projectExecutorTaskSdkResponse(
      { findById: vi.fn().mockResolvedValue({ task_id: 'task-1', session_id: 'session-1' }) },
      {
        findById: vi
          .fn()
          .mockResolvedValue({ session_id: 'session-1', agentic_tool: 'claude-code' }),
      }
    );

    await expect(hook(context)).resolves.toBe(context);
    expect(context.data).toEqual({
      raw_sdk_response: {
        type: 'result',
        subtype: 'success',
        duration_ms: 7,
        is_error: false,
        num_turns: 0,
        usage: {
          input_tokens: 3,
        },
      },
    });
    expect(JSON.stringify(context.data)).not.toContain(sentinel);
  });

  it('does not alter another agentic tool raw response', async () => {
    const raw = { type: 'turn.completed', usage: { input_tokens: 1 } };
    const context = {
      id: 'task-1',
      data: { raw_sdk_response: raw },
      params: { provider: 'socketio' },
    } as unknown as HookContext;
    const hook = projectExecutorTaskSdkResponse(
      { findById: vi.fn().mockResolvedValue({ task_id: 'task-1', session_id: 'session-1' }) },
      {
        findById: vi.fn().mockResolvedValue({ session_id: 'session-1', agentic_tool: 'codex' }),
      }
    );

    await hook(context);
    expect((context.data as { raw_sdk_response: unknown }).raw_sdk_response).toBe(raw);
  });
});

describe('tenant-owned service registration', () => {
  type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;
  type RegisteredHooks = {
    before?: Partial<Record<'all' | 'create', RegisteredHook[]>>;
  };

  const captureScheduleRegistrations = (): RegisteredHooks[] => {
    const registrations: RegisteredHooks[] = [];
    const app = {
      service(path: string) {
        return {
          hooks(hooks: RegisteredHooks) {
            if (path.replace(/^\//, '') === 'schedules') registrations.push(hooks);
          },
        };
      },
      use() {},
      publish() {},
    };

    registerHooks({
      db: {} as RegisterHooksContext['db'],
      app: app as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
        execution: { branch_rbac: false },
      } as RegisterHooksContext['config'],
      jwtSecret: 'registration-test-secret',
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin: true },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });

    return registrations;
  };

  const runRegisteredScheduleCreateBeforeHooks = async (
    registrations: RegisteredHooks[]
  ): Promise<HookContext> => {
    const context = {
      path: 'schedules',
      method: 'create',
      data: {
        branch_id: '00000000-0000-7000-8000-000000000001',
        name: 'Nightly',
        cron_expression: '0 0 * * *',
        timezone_mode: 'utc',
        prompt: 'Run',
        agentic_tool_config: { agentic_tool: 'codex' },
      },
      params: {
        provider: 'rest',
        user: { user_id: 'registration-test-user', role: 'member' },
      },
    } as HookContext;

    for (const registration of registrations) {
      for (const hook of registration.before?.all ?? []) {
        await hook(context);
      }
    }

    for (const registration of registrations) {
      for (const hook of registration.before?.create ?? []) {
        await hook(context);
      }
    }

    return context;
  };

  it('keeps schedule create DTOs valid through the registered tenant hook', async () => {
    const context = await runRegisteredScheduleCreateBeforeHooks(captureScheduleRegistrations());

    expect(context.params.tenant?.tenant_id).toBe('registration-test');
    expect(context.data).toMatchObject({
      created_by: 'registration-test-user',
      next_run_at: expect.any(Number),
    });
    expect(context.data).not.toHaveProperty('tenant_id');
  });

  it('wraps gateway inbound routing in tenant database scope', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toContain('gateway');
  });

  it('wraps custom board archive routes in tenant database scope', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toEqual(
      expect.arrayContaining(['boards/:id/archive', 'boards/:id/unarchive'])
    );
  });

  it('wraps MCP OAuth/session database helpers in tenant scope without holding network I/O open', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toEqual(
      expect.arrayContaining([
        'sessions/:id/mcp-servers',
        'mcp-servers/oauth-attempt-status',
        'mcp-servers/oauth-disconnect',
        'mcp-servers/oauth-status',
      ])
    );
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toEqual(
      expect.arrayContaining(['mcp-servers/oauth-auth-headers', 'mcp-servers/oauth-refresh'])
    );
  });

  it('fails closed for discovery that can enter the process-local MCP OAuth flow in HA', () => {
    expect(CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES).toContainEqual([
      'mcp-servers/discover',
      'mcpOAuth',
    ]);
  });

  // These remain in the capability-gate inventory, but a safe constrained-HA
  // deployment resolves both capabilities true and admits the durable paths.
  it('capability-gates the Claude OAuth attempt flow and credential-file logout in HA', () => {
    expect(CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES).toContainEqual([
      'claude-auth/oauth',
      'claudeOAuth',
    ]);
    expect(CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES).toContainEqual([
      'claude-auth/logout',
      'claudeAuth',
    ]);
  });

  it('wraps Knowledge policy and indexing admin services in tenant database scope', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toEqual(
      expect.arrayContaining([
        'kb/graph',
        'kb/settings',
        'kb/indexing/status',
        'kb/indexing/reindex',
      ])
    );
  });
});

describe('registered RBAC authentication boundary', () => {
  type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;
  type RegisteredHooks = { before?: { all?: RegisteredHook[] } };

  const captureRbacHooks = () => {
    const registrations = new Map<string, RegisteredHooks[]>();
    const requireAuth = vi.fn(async (context: HookContext) => {
      context.params.user = {
        user_id: '00000000-0000-7000-8000-000000000001',
        role: 'admin',
      } as HookContext['params']['user'];
      return context;
    });
    const app = {
      service(path: string) {
        const normalized = path.replace(/^\//, '');
        return {
          hooks(hooks: RegisteredHooks) {
            registrations.set(normalized, [...(registrations.get(normalized) ?? []), hooks]);
          },
          emit: vi.fn(),
        };
      },
      use() {},
      publish() {},
      emit: vi.fn(),
    };

    registerHooks({
      db: {} as RegisterHooksContext['db'],
      app: app as unknown as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'rbac-auth-test' },
        execution: { branch_rbac: true },
      } as RegisterHooksContext['config'],
      jwtSecret: 'rbac-auth-test-secret',
      requireAuth,
      superadminOpts: { allowSuperadmin: true },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });

    return { registrations, requireAuth };
  };

  it('keeps every authenticated RBAC service inside tenant database scope', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toEqual(
      expect.arrayContaining([...AUTHENTICATED_RBAC_SERVICE_PATHS])
    );
  });

  it.each(AUTHENTICATED_RBAC_SERVICE_PATHS)(
    'normalizes REST authentication before %s authorization',
    async (path) => {
      const { registrations, requireAuth } = captureRbacHooks();
      const allHooks = (registrations.get(path) ?? []).flatMap(
        (registration) => registration.before?.all ?? []
      );
      const authenticationHook = allHooks.find((hook) => hook === requireAuth);
      expect(authenticationHook).toBe(requireAuth);
      expect(allHooks[0]).toBe(requireAuth);

      const context = {
        path,
        method: 'find',
        params: {
          provider: 'rest',
          authentication: { strategy: 'jwt', accessToken: 'signed-token' },
        },
      } as unknown as HookContext;
      await authenticationHook?.(context);

      expect(requireAuth).toHaveBeenCalledOnce();
      expect(context.params.user).toMatchObject({ role: 'admin' });
    }
  );
});

describe('registered tenant write-gate classification', () => {
  type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;
  type RegisteredAroundHook = (context: HookContext, next: () => Promise<void>) => Promise<void>;
  type RegisteredHooks = {
    around?: { all?: RegisteredAroundHook[] };
    before?: { all?: RegisteredHook[] };
  };

  const runInstalledTenantGate = async (method: string) => {
    const registrations: RegisteredHooks[] = [];
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          {
            value_text: JSON.stringify({
              generation: 'held-generation',
              acquiredAt: '2026-08-21T00:00:00.000Z',
            }),
          },
        ]),
    };
    const db = {
      transaction: vi.fn(async (callback: (scoped: unknown) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      service(path: string) {
        return {
          hooks(hooks: RegisteredHooks) {
            if (path.replace(/^\//, '') === 'users') registrations.push(hooks);
          },
          emit: vi.fn(),
        };
      },
      use() {},
      publish() {},
      emit: vi.fn(),
    };

    registerHooks({
      db: db as RegisterHooksContext['db'],
      app: app as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
        execution: { branch_rbac: false },
      } as RegisterHooksContext['config'],
      jwtSecret: 'registration-test-secret',
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin: true },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });

    const tenantHooks = registrations.find((hooks) => hooks.around?.all?.length);
    expect(tenantHooks).toBeDefined();
    const context = {
      path: 'users',
      method,
      params: { provider: 'socketio' },
    } as unknown as HookContext;
    const operation = vi.fn(async () => undefined);
    await tenantHooks?.around?.all?.[0](context, async () => {
      for (const hook of tenantHooks.before?.all ?? []) await hook(context);
      await operation();
    });
    return { context, operation, tx };
  };

  it('rejects a custom mutator while the tenant write gate is held', async () => {
    await expect(runInstalledTenantGate('setPrimaryTeammate')).rejects.toThrow(/write-gated/);
  });

  it('allows a custom read without consulting the held tenant write gate', async () => {
    const { context, operation, tx } = await runInstalledTenantGate('getPrimaryTeammate');
    expect(operation).toHaveBeenCalledOnce();
    expect(context.params.tenant).toEqual({
      tenant_id: 'registration-test',
      source: 'static',
    });
    expect(tx.execute).toHaveBeenCalledOnce();
  });
});

describe('registered external board-comment mutation boundary', () => {
  type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;
  type RegisteredHooks = {
    before?: Partial<Record<'patch' | 'update', RegisteredHook[]>>;
  };

  const captureBoardCommentHooks = (): RegisteredHooks[] => {
    const registrations: RegisteredHooks[] = [];
    const app = {
      service(path: string) {
        return {
          hooks(hooks: RegisteredHooks) {
            if (path.replace(/^\//, '') === 'board-comments') registrations.push(hooks);
          },
        };
      },
      use() {},
      publish() {},
    };

    registerHooks({
      db: {} as RegisterHooksContext['db'],
      app: app as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
        execution: { branch_rbac: false },
      } as RegisterHooksContext['config'],
      jwtSecret: 'registration-test-secret',
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin: true },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });
    return registrations;
  };

  const runMethodHooks = async (method: 'patch' | 'update', data: unknown) => {
    const context = {
      path: 'board-comments',
      method,
      id: 'comment-1',
      data,
      params: {
        provider: 'socketio',
        user: { user_id: 'member-1', role: 'member' },
      },
    } as HookContext;
    for (const registration of captureBoardCommentHooks()) {
      for (const hook of registration.before?.[method] ?? []) await hook(context);
    }
    return context;
  };

  it('rejects reaction and derived-state forgery through the actual patch hooks', async () => {
    await expect(
      runMethodHooks('patch', {
        content: 'edited',
        reactions: [{ user_id: 'another-user', emoji: '👍' }],
        edited: false,
      })
    ).rejects.toThrow(/Unsupported board comment patch fields/);
  });

  it('rejects external complete replacement through the actual update hooks', async () => {
    await expect(
      runMethodHooks('update', {
        content: 'replacement',
        reactions: [{ user_id: 'another-user', emoji: '👍' }],
      })
    ).rejects.toThrow(/do not support external update/);
  });

  it('preserves the canonical content/resolved patch contract', async () => {
    const context = await runMethodHooks('patch', { content: 'edited', resolved: true });
    expect(context.data).toEqual({ content: 'edited', resolved: true });
  });
});

describe('registered board admin authority', () => {
  type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;
  type RegisteredHooks = {
    before?: Partial<Record<'find' | 'patch', RegisteredHook[]>>;
  };

  const captureBoardHooks = (allowSuperadmin: boolean): RegisteredHooks[] => {
    const registrations: RegisteredHooks[] = [];
    const app = {
      service(path: string) {
        return {
          hooks(hooks: RegisteredHooks) {
            if (path.replace(/^\//, '') === 'boards') registrations.push(hooks);
          },
        };
      },
      use() {},
      publish() {},
    };

    registerHooks({
      db: {} as RegisterHooksContext['db'],
      app: app as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
        execution: { branch_rbac: true },
      } as RegisterHooksContext['config'],
      jwtSecret: 'registration-test-secret',
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });

    return registrations;
  };

  it('preserves ordinary board-admin authority for superadmins when bypass is disabled', async () => {
    const context = {
      path: 'boards',
      method: 'patch',
      id: 'board-1',
      data: { name: 'Renamed' },
      params: {
        provider: 'rest',
        user: { user_id: 'super-1', role: 'superadmin' },
      },
    } as HookContext;

    const registrations = captureBoardHooks(false);
    expect(registrations).not.toHaveLength(0);
    for (const registration of registrations) {
      for (const hook of registration.before?.patch ?? []) {
        await hook(context);
      }
    }

    expect(context).toBeDefined();
  });

  it.each([
    ['member', false],
    ['admin', false],
    ['superadmin', false],
  ] as const)(
    'scopes registered boards.find for %s when allowSuperadmin=%s',
    async (role, allowSuperadmin) => {
      const context = {
        path: 'boards',
        method: 'find',
        params: {
          provider: 'socketio',
          user: { user_id: `${role}-1`, role },
          query: { board_id: { $in: ['visible', 'private'] } },
        },
      } as HookContext;

      for (const registration of captureBoardHooks(allowSuperadmin)) {
        for (const hook of registration.before?.find ?? []) await hook(context);
      }

      expect(
        (context.params as HookContext['params'] & { _agorSqlBoardAccessUserId?: string })
          ._agorSqlBoardAccessUserId
      ).toBe(`${role}-1`);
    }
  );

  it('allows only the explicitly configured superadmin boards.find bypass', async () => {
    const context = {
      path: 'boards',
      method: 'find',
      params: {
        provider: 'socketio',
        user: { user_id: 'super-1', role: 'superadmin' },
        query: {},
      },
    } as HookContext;

    for (const registration of captureBoardHooks(true)) {
      for (const hook of registration.before?.find ?? []) await hook(context);
    }

    expect(
      (context.params as HookContext['params'] & { _agorSqlBoardAccessUserId?: string })
        ._agorSqlBoardAccessUserId
    ).toBeUndefined();
  });
});

describe('shouldValidateRepoEnvironmentPayload', () => {
  it('skips absent repo environment payloads', () => {
    expect(shouldValidateRepoEnvironmentPayload(undefined)).toBe(false);
    expect(shouldValidateRepoEnvironmentPayload(null)).toBe(false);
  });

  it('validates present repo environment payloads', () => {
    expect(shouldValidateRepoEnvironmentPayload({})).toBe(true);
    expect(shouldValidateRepoEnvironmentPayload('invalid shape')).toBe(true);
  });
});

describe('branch environment materialization validation', () => {
  it('does not reject branch creation when the rendered health URL is invalid', async () => {
    const context = {
      path: 'branches',
      method: 'create',
      data: {
        start_command: 'pnpm dev',
        stop_command: 'pkill -f pnpm',
        health_check_url: 'not-an-http-url',
      },
      params: {},
    } as HookContext;

    await expect(
      validateBranchEnvPolicyHook({
        execution: { managed_envs_execution_mode: 'hybrid' },
      })(context)
    ).resolves.toBe(context);
  });

  it('does not reject a materialization patch with an invalid rendered health URL', async () => {
    const existing = {
      branch_id: 'branch-1',
      repo_id: 'repo-1',
      name: 'branch-1',
      path: '/tmp/branch-1',
      ref: 'branch-1',
      ref_type: 'branch',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      created_by: 'user-1',
    } as Branch;
    const get = vi.fn(async () => existing);
    const context = {
      path: 'branches',
      method: 'patch',
      id: existing.branch_id,
      data: {
        environment_variant: 'dev',
        start_command: 'pnpm dev',
        stop_command: 'pkill -f pnpm',
        health_check_url: 'not-an-http-url',
      },
      params: {},
      service: { get },
    } as HookContext;

    await expect(
      validateBranchEnvPolicyHook({
        execution: { managed_envs_execution_mode: 'hybrid' },
      })(context)
    ).resolves.toBe(context);
    expect(get).toHaveBeenCalledWith(existing.branch_id, context.params);
  });

  it('still rejects unsafe rendered app URLs before persistence', async () => {
    const context = {
      path: 'branches',
      method: 'create',
      data: {
        start_command: 'pnpm dev',
        app_url: 'javascript:alert(1)',
      },
      params: {},
    } as HookContext;

    await expect(
      validateBranchEnvPolicyHook({
        execution: { managed_envs_execution_mode: 'hybrid' },
      })(context)
    ).rejects.toThrow('managed environment app URL');
  });

  it('rejects an invalid snapshotted startup timeout before persistence', async () => {
    const context = {
      path: 'branches',
      method: 'create',
      data: {
        start_command: 'pnpm dev',
        startup_timeout_ms: 999,
      },
      params: {},
    } as HookContext;

    await expect(
      validateBranchEnvPolicyHook({
        execution: { managed_envs_execution_mode: 'hybrid' },
      })(context)
    ).rejects.toThrow('startup_timeout_ms');
  });
});

describe('shouldRunSessionPostTurnHooks', () => {
  it('runs for idle sessions, preserving stop-route gateway finalization behavior', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'idle', ready_for_prompt: false })).toBe(true);
  });

  it('runs for failed sessions only once they are promptable', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'failed', ready_for_prompt: true })).toBe(true);
    expect(shouldRunSessionPostTurnHooks({ status: 'failed', ready_for_prompt: false })).toBe(
      false
    );
  });

  it('does not run for busy sessions', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'running', ready_for_prompt: false })).toBe(
      false
    );
  });
});

describe('getTrustedSessionTenantId', () => {
  it('reads non-enumerable tenant metadata from session DTOs without requiring JSON exposure', () => {
    const session = makeSession('session-1');
    Object.defineProperty(session, 'tenant_id', {
      value: 'tenant-from-row',
      enumerable: false,
    });

    expect(getTrustedSessionTenantId(session)).toBe('tenant-from-row');
    expect(Object.keys(session)).not.toContain('tenant_id');
    expect(JSON.stringify(session)).not.toContain('tenant_id');
  });

  it('ignores absent or empty tenant metadata', () => {
    expect(getTrustedSessionTenantId(makeSession('session-1'))).toBeUndefined();
    expect(getTrustedSessionTenantId({ tenant_id: '' })).toBeUndefined();
  });
});

describe('shouldDrainQueueAfterSessionPostTurnPatch', () => {
  it('drains for promptable ready sessions by default', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'failed', ready_for_prompt: true })
    ).toBe(true);
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'idle', ready_for_prompt: true })
    ).toBe(true);
  });

  it('does not drain when terminal queue processing is explicitly suppressed', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch(
        { status: 'failed', ready_for_prompt: true },
        { suppressTerminalQueueProcessing: true }
      )
    ).toBe(false);
  });

  it('does not drain for promptable-but-not-ready acknowledgement states', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'idle', ready_for_prompt: false })
    ).toBe(false);
  });
});

describe('enrichSessionFindResultWithRemoteRelationships', () => {
  it('enriches paginated results produced by before.find RBAC scoping', async () => {
    const session = makeSession('session-1');
    const relationship = {
      relationship_id: 'relationship-1',
      source_session_id: 'session-1',
      target_session_id: 'session-2',
      relationship_type: 'remote_create',
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      callback_enabled: false,
      callback_session_id: null,
      data: null,
    } as const;
    let calls = 0;
    const service = {
      async enrichRemoteRelationships(sessions: import('@agor/core/types').Session[]) {
        calls += 1;
        return sessions.map((item) =>
          item.session_id === session.session_id
            ? { ...item, remote_relationships: { as_source: [relationship], as_target: [] } }
            : item
        );
      },
    };

    const result = await enrichSessionFindResultWithRemoteRelationships(
      { total: 1, limit: 10, skip: 0, data: [session] },
      service
    );

    expect(calls).toBe(1);
    expect(Array.isArray(result)).toBe(false);
    expect(Array.isArray(result) ? null : result.data[0].remote_relationships?.as_source?.[0]).toBe(
      relationship
    );
  });

  it('does not enrich a result that the sessions service already enriched', async () => {
    const session = makeSession('session-1');
    let calls = 0;
    const service = {
      async enrichRemoteRelationships(sessions: import('@agor/core/types').Session[]) {
        calls += 1;
        return sessions.map((item) => ({ ...item, title: 'enriched twice' }));
      },
    };

    const once = await enrichSessionFindResultWithRemoteRelationships([session], service);
    const twice = await enrichSessionFindResultWithRemoteRelationships(once, service);

    expect(twice).toBe(once);
    expect(calls).toBe(1);
    expect((twice as import('@agor/core/types').Session[])[0].title).toBe('enriched twice');
  });
});

describe('isPromptFlowPatchOnly', () => {
  describe('accepts whitelisted-only patches', () => {
    it.each(PROMPT_FLOW_PATCH_FIELDS.map((f) => [f]))(
      'accepts single whitelisted field: %s',
      (field) => {
        expect(isPromptFlowPatchOnly({ [field]: 'any-value' })).toBe(true);
      }
    );

    it('accepts the prompt-route task-append shape', () => {
      // register-routes.ts: /sessions/:id/prompt appends task_id to session.tasks
      expect(isPromptFlowPatchOnly({ tasks: ['task-1', 'task-2'] })).toBe(true);
    });

    it('accepts the prompt-route auto-unarchive shape', () => {
      // register-routes.ts: /sessions/:id/prompt auto-unarchives before sending
      expect(isPromptFlowPatchOnly({ archived: false, archived_reason: undefined })).toBe(true);
    });

    it('accepts the stop-route idle shape', () => {
      // register-routes.ts: /sessions/:id/stop sets status + ready_for_prompt
      // (ready_for_prompt: true so the post-patch hook drains any QUEUED tasks)
      expect(isPromptFlowPatchOnly({ status: 'idle', ready_for_prompt: true })).toBe(true);
    });

    it('accepts the executor opencode init shape', () => {
      // packages/executor/src/handlers/sdk/opencode.ts patches the SDK session handle
      expect(isPromptFlowPatchOnly({ sdk_session_id: 'opencode-sess-123' })).toBe(true);
    });
  });

  describe('rejects mixed or metadata patches', () => {
    it('rejects a patch that mixes whitelist + metadata field', () => {
      // Prevents partial-trust escalation: if `tasks` is allowed at session-tier,
      // a caller must NOT be able to piggyback `name` (metadata) onto the same patch.
      expect(isPromptFlowPatchOnly({ tasks: ['t'], name: 'evil' })).toBe(false);
    });

    it.each([
      ['name', 'metadata'],
      ['model_config', { model: 'x' }],
      ['permission_config', { mode: 'bypass' }],
      ['callback_config', { callback_session_id: 'sid' }],
      ['created_by', 'other-user'],
      ['unix_username', 'root'],
      ['branch_id', 'wt-evil'],
    ])('rejects pure-metadata patch on field: %s', (field, value) => {
      expect(isPromptFlowPatchOnly({ [field]: value })).toBe(false);
    });
  });

  describe('rejects non-object inputs', () => {
    it('rejects null', () => {
      expect(isPromptFlowPatchOnly(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isPromptFlowPatchOnly(undefined)).toBe(false);
    });

    it('rejects empty object (nothing to patch = cannot be a prompt-flow patch)', () => {
      expect(isPromptFlowPatchOnly({})).toBe(false);
    });

    it('rejects primitives', () => {
      expect(isPromptFlowPatchOnly('string')).toBe(false);
      expect(isPromptFlowPatchOnly(42)).toBe(false);
      expect(isPromptFlowPatchOnly(true)).toBe(false);
    });
  });
});

/**
 * Guards the fix for CVE-class issue: `after: get` on /sessions was minting
 * an MCP token (with `uid = session.created_by`) for any `member+` caller
 * with `view` permission on the branch, letting them impersonate the
 * creator on the MCP channel. Only the creator, a superadmin, or the
 * executor's service identity may receive the token.
 */
describe('canReceiveMcpTokenForSession', () => {
  const CREATOR = 'user-creator';
  const OTHER = 'user-other';

  it('allows any authenticated member+ caller to receive a caller-scoped MCP token', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'member',
      })
    ).toBe(true);
  });

  it('allows a superadmin even if not the creator', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'superadmin',
      })
    ).toBe(true);
  });

  it('allows the executor service identity (role=service)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: 'executor-service',
        callerRole: 'service',
      })
    ).toBe(true);
  });

  it('denies a creator who has been demoted to viewer', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: CREATOR,
        callerRole: 'viewer',
      })
    ).toBe(false);
  });

  it('denies anonymous callers (no user_id, no role)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: undefined,
        callerRole: undefined,
      })
    ).toBe(false);
  });

  it('denies callers with user_id but no explicit role', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: CREATOR,
        callerRole: undefined,
      })
    ).toBe(false);
  });

  it('denies empty-string caller user_id even with member role', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: '',
        callerRole: 'member',
      })
    ).toBe(false);
  });
});

describe('TENANT_IDENTITY_ONLY_SERVICE_PATHS', () => {
  it.each(['file', 'files'])('%s is identity-only and never request-transaction owned', (path) => {
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain(path);
    expect(TENANT_OWNED_SERVICE_PATHS).not.toContain(path);
  });

  // Regression: the codex-auth endpoints do network/process work after a short
  // tenant DB read, then call getCurrentTenantId() to open their own units of
  // work — so they must carry ambient tenant identity via the identity-only
  // around hook. codex-auth/logout was missing here, so `Remove login` ran with
  // no active tenant scope and threw "Missing active tenant context for Codex
  // auth logout" — the delete-only logout never worked end-to-end.
  it.each(['codex-auth/device', 'codex-auth/import', 'codex-auth/logout'])(
    'grants ambient tenant identity to %s',
    (path) => {
      expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain(path);
    }
  );

  it('keeps the codex-auth endpoints grouped together', () => {
    const codexPaths = TENANT_IDENTITY_ONLY_SERVICE_PATHS.filter((path) =>
      path.startsWith('codex-auth/')
    );
    expect(codexPaths).toEqual(['codex-auth/device', 'codex-auth/import', 'codex-auth/logout']);
  });

  it.each([
    'mcp-servers/discover',
    'mcp-servers/oauth-complete',
    'mcp-servers/oauth-start',
    'mcp-servers/test-oauth',
  ])('keeps provider/waiting endpoint %s out of an HTTP-long transaction', (path) => {
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain(path);
    expect(TENANT_OWNED_SERVICE_PATHS).not.toContain(path);
  });

  // Regression for the live blocker: /claude-auth/oauth was in NEITHER tenant
  // list, so no around hook established ambient identity and its create/find
  // threw "Missing active tenant context for Claude OAuth" — while the identical
  // codex-auth/device worked. Exercise the REAL registration path (no manual
  // runWithTenantContext) so the gap is catchable, unlike the service unit tests
  // that establish tenant context by hand.
  it.each(['claude-auth/oauth', 'claude-auth/logout'])(
    'grants ambient tenant identity to %s',
    (path) => {
      expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain(path);
      expect(TENANT_OWNED_SERVICE_PATHS).not.toContain(path);
    }
  );

  it('puts both Claude credential mutation endpoints behind short write admission', () => {
    expect(CLAUDE_CREDENTIAL_WRITE_ADMISSION_SERVICE_PATHS).toEqual([
      'claude-auth/oauth',
      'claude-auth/logout',
    ]);
  });

  it('populates getCurrentTenantId() for a claude-auth/oauth call via the registered hook', async () => {
    type AroundHook = (context: HookContext, next: () => Promise<void>) => Promise<void>;
    const captured: AroundHook[] = [];
    const app = {
      service(path: string) {
        return {
          hooks(hooks: { around?: { all?: AroundHook[] } }) {
            if (path.replace(/^\//, '') === 'claude-auth/oauth') {
              captured.push(...(hooks.around?.all ?? []));
            }
          },
        };
      },
      use() {},
      publish() {},
    };

    registerHooks({
      db: {} as RegisterHooksContext['db'],
      app: app as RegisterHooksContext['app'],
      config: {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'registration-test' },
      } as RegisterHooksContext['config'],
      jwtSecret: 'registration-test-secret',
      branchRbacEnabled: false,
      requireAuth: async (context) => context,
      superadminOpts: { allowSuperadmin: true },
      sessionsService: {} as RegisterHooksContext['sessionsService'],
      messagesService: {} as RegisterHooksContext['messagesService'],
      boardsService: undefined,
      branchRepository: {} as RegisterHooksContext['branchRepository'],
      usersRepository: {} as RegisterHooksContext['usersRepository'],
      sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
      deployment: { mode: 'standalone' },
    });

    // The service must actually receive an around hook — an empty capture is the
    // exact production failure (no ambient identity), so assert it is wired.
    expect(captured.length).toBeGreaterThan(0);

    const context = {
      path: 'claude-auth/oauth',
      method: 'create',
      data: {},
      params: { provider: 'rest', user: { user_id: 'registration-test-user', role: 'member' } },
    } as HookContext;
    // `next` runs where the service body runs; it must see the ambient tenant.
    let tenantDuringCall: string | undefined;
    const next = async () => {
      tenantDuringCall = getCurrentTenantId() ?? undefined;
    };
    const invoke = captured.reduceRight<() => Promise<void>>(
      (downstream, hook) => () => hook(context, downstream),
      next
    );
    await invoke();

    expect(context.params.tenant?.tenant_id).toBe('registration-test');
    expect(tenantDuringCall).toBe('registration-test');
  });

  it('keeps gateway channel provider probes outside the request transaction', () => {
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain('gateway-channels');
    expect(TENANT_OWNED_SERVICE_PATHS).not.toContain('gateway-channels');
  });
});

describe('registered file service RBAC database preload', () => {
  type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;

  it.each(['file', 'files'])(
    'runs the actual %s RBAC preload registration inside tenant database scope',
    async (path) => {
      const captured = new Map<string, RegisteredHook[]>();
      const assertTenantScope = () => {
        expect(getCurrentTenantDatabaseScope()?.tenantId).toBe('tenant-a');
      };
      const branch = { branch_id: 'branch-1', path: '/branch-1', others_can: 'view' };
      const branchRepository = {
        findById: vi.fn(async () => {
          assertTenantScope();
          return branch;
        }),
        isOwner: vi.fn(async () => {
          assertTenantScope();
          return true;
        }),
        resolveUserPermission: vi.fn(async () => {
          assertTenantScope();
          return 'all';
        }),
      };
      const sessionsService = {
        get: vi.fn(async () => {
          assertTenantScope();
          return { session_id: 'session-1', branch_id: 'branch-1' };
        }),
      };
      const sessionsRepository = {
        findById: vi.fn(async () => {
          assertTenantScope();
          return { session_id: 'session-1', branch_id: 'branch-1' };
        }),
      };
      const app = {
        service(servicePath: string) {
          return {
            hooks(hooks: { before?: { all?: RegisteredHook[] } }) {
              const normalizedPath = servicePath.replace(/^\//, '');
              if (hooks.before?.all) captured.set(normalizedPath, hooks.before.all);
            },
          };
        },
        use() {},
        publish() {},
      };

      registerHooks({
        db: { run: vi.fn() } as RegisterHooksContext['db'],
        app: app as RegisterHooksContext['app'],
        config: {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'static', static_tenant_id: 'tenant-a' },
          execution: { branch_rbac: true },
        } as RegisterHooksContext['config'],
        jwtSecret: 'registration-test-secret',
        requireAuth: async (context) => context,
        superadminOpts: { allowSuperadmin: true },
        sessionsService: sessionsService as RegisterHooksContext['sessionsService'],
        messagesService: {} as RegisterHooksContext['messagesService'],
        boardsService: undefined,
        branchRepository: branchRepository as RegisterHooksContext['branchRepository'],
        usersRepository: {} as RegisterHooksContext['usersRepository'],
        sessionsRepository:
          sessionsRepository as unknown as RegisterHooksContext['sessionsRepository'],
        deployment: { mode: 'standalone' },
      });

      const context = {
        path,
        method: 'find',
        params: {
          provider: 'rest',
          query:
            path === 'file'
              ? { branch_id: 'branch-1' }
              : { sessionId: 'session-1', search: 'readme' },
          user: { user_id: 'user-1', role: 'superadmin' },
        },
      } as HookContext;

      await runWithTenantContext('tenant-a', async () => {
        for (const hook of captured.get(path) ?? []) await hook(context);
      });

      expect(context.params.branch?.branch_id).toBe('branch-1');
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      if (path === 'files') {
        expect(sessionsRepository.findById).toHaveBeenCalledOnce();
        expect(sessionsService.get).not.toHaveBeenCalled();
      } else expect(branchRepository.findById).toHaveBeenCalledOnce();
    }
  );
});

describe('file service RBAC database preload', () => {
  it.each(['file', 'files'])(
    'scopes guarded reads for %s and closes scope afterward',
    async (path) => {
      const guarded = createTenantScopedDatabaseProxy({ run: () => 'ok' } as never, {
        requireScope: true,
        label: `${path} hook test`,
      });
      const read = async (context: HookContext) => {
        expect(guarded.run).toBeTypeOf('function');
        expect(getCurrentTenantDatabaseScope()?.tenantId).toBe('tenant-a');
        context.params.branch = { branch_id: 'branch-1' } as never;
        return context;
      };
      const hook = createTenantScopedBeforeHookChain(guarded, read);
      const context = { path, params: {} } as HookContext;

      await runWithTenantContext('tenant-a', () => hook(context));

      expect(context.params.branch?.branch_id).toBe('branch-1');
      expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      expect(() => guarded.run).toThrow(
        `Missing tenant database scope for ${path} hook test access`
      );
    }
  );

  it.each(['file', 'files'])(
    'fails before opening %s RBAC work without tenant identity',
    async (path) => {
      const read = vi.fn();
      const hook = createTenantScopedBeforeHookChain({ run: vi.fn() } as never, read);

      await expect(hook({ path, params: {} } as HookContext)).rejects.toThrow(
        `Missing active tenant context for ${path} authorization`
      );
      expect(read).not.toHaveBeenCalled();
    }
  );
});
