import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  hasExactUserExecutorCredentialHome: vi.fn(() => false),
  loadConfig: vi.fn(async () => ({})),
  resolveApiKey: vi.fn(),
}));

const homeMocks = vi.hoisted(() => ({
  resolveExecutionCredentialHome: vi.fn(async ({ userId }: { userId: string }) => ({
    delegatedHomeKey: null,
    homeStore: `/homes/${userId}`,
    homeStoreSource: 'canonical',
  })),
  sameExecutionCredentialHome: vi.fn(
    (a: { homeStore: string }, b: { homeStore: string }) => a.homeStore === b.homeStore
  ),
}));

const dbMocks = vi.hoisted(() => ({
  runWithTenantDatabaseScope: vi.fn(
    async (db: unknown, _tenantId: unknown, work: (db: unknown) => unknown) => work(db)
  ),
}));

vi.mock('@agor/core/config', () => configMocks);
vi.mock('@agor/core/db', () => dbMocks);
vi.mock('./credential-home-identity.js', () => homeMocks);

import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { TaskID, UserID } from '@agor/core/types';
import { ConfigService } from './config.js';

describe('ConfigService.resolveApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.hasExactUserExecutorCredentialHome.mockReturnValue(false);
    homeMocks.resolveExecutionCredentialHome.mockImplementation(async ({ userId }) => ({
      delegatedHomeKey: null,
      homeStore: `/homes/${userId}`,
      homeStoreSource: 'canonical',
    }));
    homeMocks.sameExecutionCredentialHome.mockImplementation((a, b) => a.homeStore === b.homeStore);
    configMocks.resolveApiKey.mockResolvedValue({
      apiKey: 'resolved-test-key',
      source: 'user',
      useNativeAuth: false,
    });
  });

  it('rejects unauthenticated external callers before resolving secrets', async () => {
    const service = new ConfigService({} as never);

    await expect(
      service.resolveApiKey({ taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY' }, {
        provider: 'rest',
      } as never)
    ).rejects.toBeInstanceOf(NotAuthenticated);

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('rejects authenticated non-service external callers before resolving secrets', async () => {
    const service = new ConfigService({} as never);

    await expect(
      service.resolveApiKey({ taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY' }, {
        provider: 'rest',
        user: { user_id: 'user-1' },
      } as never)
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('rejects unsupported key names before resolving secrets', async () => {
    const service = new ConfigService({} as never);

    await expect(
      service.resolveApiKey({ taskId: 'task-1' as TaskID, keyName: 'UNRELATED_ENV_VAR' }, {
        provider: 'socketio',
        user: { user_id: 'executor-service', _isServiceAccount: true },
      } as never)
    ).rejects.toBeInstanceOf(BadRequest);

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('allows an explicit daemon service account and resolves for the task creator', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        expect(name).toBe('tasks');
        return {
          get: vi.fn(async () => ({ created_by: 'creator-1' as UserID })),
        };
      },
    } as never;

    const result = await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        user: { user_id: 'executor-service', _isServiceAccount: true },
      } as never
    );

    expect(result).toEqual({
      apiKey: 'resolved-test-key',
      source: 'user',
      useNativeAuth: false,
    });
    expect(configMocks.resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', {
      userId: 'creator-1',
      db: {},
      tool: 'codex',
    });
  });

  it('allows task-scoped executor runtime tokens for the matching session tool', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'creator-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'codex' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    const result = await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        user: { user_id: 'creator-1' },
        authentication: {
          strategy: 'jwt',
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            task_id: 'task-1',
            session_id: 'session-1',
          },
        },
      } as never
    );

    expect(result).toMatchObject({ apiKey: 'resolved-test-key', source: 'user' });
    expect(configMocks.resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', {
      userId: 'creator-1',
      db: {},
      tool: 'codex',
    });
  });

  it('rejects a task-scoped executor principal that differs from the Task creator', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'creator-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          user: { user_id: 'collaborator-2' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: 'session-1',
            },
          },
        } as never
      )
    ).rejects.toThrow('Executor token task scope could not be verified');

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('does not grant plaintext credentials to taskless command delegation', async () => {
    const service = new ConfigService({} as never);

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          user: { user_id: 'creator-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-command',
              session_id: 'branch-clean',
              branch_id: 'branch-1',
            },
          },
        } as never
      )
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('requires the signed session and branch to match the task session', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return { get: vi.fn(async () => ({ created_by: 'creator-1', session_id: 'session-1' })) };
        }
        if (name === 'sessions') {
          return {
            get: vi.fn(async () => ({ agentic_tool: 'codex', branch_id: 'branch-1' })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    const request = (sessionId: string, branchId: string) =>
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          user: { user_id: 'creator-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: sessionId,
              branch_id: branchId,
            },
          },
        } as never
      );

    await expect(request('session-2', 'branch-1')).rejects.toBeInstanceOf(Forbidden);
    await expect(request('session-1', 'branch-2')).rejects.toBeInstanceOf(Forbidden);
    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('forwards the resolved tenant into the lookups and scopes key resolution to it', async () => {
    const db = { marker: 'db' };
    const service = new ConfigService(db as never);
    const taskGet = vi.fn(async () => ({
      created_by: 'creator-1' as UserID,
      session_id: 'session-1',
    }));
    const sessionGet = vi.fn(async () => ({ agentic_tool: 'codex' }));
    service.app = {
      service(name: string) {
        if (name === 'tasks') return { get: taskGet };
        if (name === 'sessions') return { get: sessionGet };
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    const tenant = { tenant_id: 'tenant-1', source: 'auth_claim' };
    await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        tenant,
        user: { user_id: 'creator-1' },
        authentication: {
          strategy: 'jwt',
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            task_id: 'task-1',
            session_id: 'session-1',
          },
        },
      } as never
    );

    expect(taskGet).toHaveBeenCalledWith('task-1', { provider: undefined, tenant });
    expect(sessionGet).toHaveBeenCalledWith('session-1', { provider: undefined, tenant });
    expect(dbMocks.runWithTenantDatabaseScope).toHaveBeenCalledWith(
      db,
      'tenant-1',
      expect.any(Function)
    );
    expect(configMocks.resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', {
      userId: 'creator-1',
      db,
      tool: 'codex',
    });
  });

  it('rejects executor scope reconstructed from caller bearer or transport fields', async () => {
    const service = new ConfigService({} as never);
    const data = {
      taskId: 'task-1' as TaskID,
      keyName: 'OPENAI_API_KEY',
      tool: 'codex',
      executorSessionToken: 'caller-bearer',
    } as never;

    await expect(
      service.resolveApiKey(data, {
        provider: 'socketio',
        authentication: { strategy: 'jwt', accessToken: 'caller-bearer' },
        user: { user_id: 'creator-1' },
        task_id: 'task-1',
        session_id: 'session-1',
      } as never)
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('rejects executor runtime tokens for a different API key than the session tool uses', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return { get: vi.fn(async () => ({ created_by: 'creator-1', session_id: 'session-1' })) };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'codex' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'ANTHROPIC_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          user: { user_id: 'creator-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: 'session-1',
            },
          },
        } as never
      )
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('rejects executor runtime tokens for tools without a canonical API key mapping', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return { get: vi.fn(async () => ({ created_by: 'creator-1', session_id: 'session-1' })) };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'opencode' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'opencode' },
        {
          provider: 'socketio',
          user: { user_id: 'creator-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: 'session-1',
            },
          },
        } as never
      )
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it('admits hosted Codex native auth only on the exact-user sandbox route', async () => {
    configMocks.resolveApiKey.mockResolvedValue({
      apiKey: null,
      source: 'user',
      useNativeAuth: true,
    });
    configMocks.hasExactUserExecutorCredentialHome.mockReturnValue(true);
    const service = new ConfigService(
      {} as never,
      {
        multi_tenancy: { mode: 'required_from_auth' },
        execution: {
          unix_user_mode: 'sandbox',
          executor_storage: { user_home: 'persistent-per-user' },
        },
      } as never
    );
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'creator-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return {
            get: vi.fn(async () => ({ agentic_tool: 'codex', created_by: 'creator-1' })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          tenant: { tenant_id: 'tenant-1' },
          user: { user_id: 'creator-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: 'session-1',
            },
          },
        } as never
      )
    ).resolves.toMatchObject({ useNativeAuth: true });
  });

  it.each([
    ['the session owner', 'creator-1', 'creator-1', false, 1],
    ['a collaborator sharing the override', 'prompter-1', 'owner-2', false, 1],
    ['only the distinct session owner', 'prompter-1', 'owner-2', true, 2],
  ])(
    'rejects an HA Codex home override for %s',
    async (_case, prompterId, ownerId, ownerOnly, expectedLookups) => {
      configMocks.resolveApiKey.mockResolvedValue({
        apiKey: null,
        source: 'user',
        useNativeAuth: true,
      });
      configMocks.hasExactUserExecutorCredentialHome.mockReturnValue(true);
      homeMocks.resolveExecutionCredentialHome.mockImplementation(async ({ userId }) =>
        ownerOnly && userId === prompterId
          ? {
              delegatedHomeKey: null,
              homeStore: `/homes/${userId}`,
              homeStoreSource: 'canonical',
            }
          : {
              delegatedHomeKey: null,
              homeStore: '/srv/shared-home',
              homeStoreSource: 'override',
            }
      );
      const service = new ConfigService(
        {} as never,
        {
          deployment: { mode: 'ha' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: {
            unix_user_mode: 'sandbox',
            executor_storage: { user_home: 'persistent-per-user' },
          },
        } as never
      );
      service.app = {
        service(name: string) {
          if (name === 'tasks') {
            return {
              get: vi.fn(async () => ({
                created_by: prompterId as UserID,
                session_id: 'session-1',
              })),
            };
          }
          if (name === 'sessions') {
            return {
              get: vi.fn(async () => ({ agentic_tool: 'codex', created_by: ownerId })),
            };
          }
          throw new Error(`unexpected service ${name}`);
        },
      } as never;

      await expect(
        service.resolveApiKey(
          { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
          {
            provider: 'socketio',
            tenant: { tenant_id: 'tenant-1' },
            user: { user_id: prompterId },
            authentication: {
              strategy: 'jwt',
              payload: {
                type: 'executor-session',
                purpose: 'executor-task',
                task_id: 'task-1',
                session_id: 'session-1',
              },
            },
          } as never
        )
      ).rejects.toThrow(/canonical tenant\/user home/);
      expect(homeMocks.resolveExecutionCredentialHome).toHaveBeenCalledTimes(expectedLookups);
      expect(homeMocks.sameExecutionCredentialHome).not.toHaveBeenCalled();
    }
  );

  it('keeps hosted native auth gated without a concrete exact-user route', async () => {
    configMocks.resolveApiKey.mockResolvedValue({
      apiKey: null,
      source: 'user',
      useNativeAuth: true,
    });
    const service = new ConfigService(
      {} as never,
      {
        multi_tenancy: { mode: 'required_from_auth' },
      } as never
    );
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'creator-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return { get: vi.fn(async () => ({ agentic_tool: 'codex' })) };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          tenant: { tenant_id: 'tenant-1' },
          user: { user_id: 'creator-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: 'session-1',
            },
          },
        } as never
      )
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('refuses to borrow native auth from a different session-owner home', async () => {
    configMocks.resolveApiKey.mockResolvedValue({
      apiKey: null,
      source: 'user',
      useNativeAuth: true,
    });
    const service = new ConfigService(
      {} as never,
      {
        multi_tenancy: { mode: 'static' },
        execution: { unix_user_mode: 'sandbox' },
      } as never
    );
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'prompter-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return {
            get: vi.fn(async () => ({ agentic_tool: 'codex', created_by: 'owner-2' })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          user: { user_id: 'prompter-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: 'session-1',
            },
          },
        } as never
      )
    ).rejects.toBeInstanceOf(Forbidden);
    expect(homeMocks.resolveExecutionCredentialHome).toHaveBeenCalledTimes(2);
    expect(homeMocks.resolveExecutionCredentialHome).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: 'prompter-1', agenticTool: 'codex' })
    );
    expect(homeMocks.resolveExecutionCredentialHome).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: 'owner-2', agenticTool: 'codex' })
    );
  });

  it('uses the foreign Task actor native auth for a branch-scoped Codex Session', async () => {
    configMocks.resolveApiKey.mockResolvedValue({
      apiKey: null,
      source: 'user',
      useNativeAuth: true,
    });
    const service = new ConfigService(
      {} as never,
      {
        multi_tenancy: { mode: 'static' },
        execution: { unix_user_mode: 'sandbox' },
      } as never
    );
    service.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: 'prompter-1' as UserID,
              session_id: 'session-1',
            })),
          };
        }
        if (name === 'sessions') {
          return {
            get: vi.fn(async () => ({
              agentic_tool: 'codex',
              created_by: 'owner-2',
              sdk_home_scope: 'branch',
            })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    await expect(
      service.resolveApiKey(
        { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
        {
          provider: 'socketio',
          user: { user_id: 'prompter-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: 'session-1',
            },
          },
        } as never
      )
    ).resolves.toMatchObject({ useNativeAuth: true });
    expect(homeMocks.resolveExecutionCredentialHome).not.toHaveBeenCalled();
  });
});
