import { createUserProcessEnvironment } from '@agor/core/config';
import {
  BranchRepository,
  getCurrentTenantId,
  MCPServerRepository,
  runWithTenantContext,
  SessionMCPServerRepository,
  UsersRepository,
} from '@agor/core/db';
import type { MCPServer, Session, SessionID, TaskID, User, UserID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecuteHandler } from './executor-launch.js';
import { markExecutorProcessExited, trackExecutorProcess } from './executor-tracking.js';
import type { RegisterServicesContext } from './register-services.js';
import { prepareSessionForExecutorStart } from './services/executor-startup.js';
import { requestExecutorTermination } from './termination-coordinator.js';
import { spawnExecutor } from './utils/spawn-executor.js';

vi.mock('./services/executor-startup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/executor-startup.js')>();
  return { ...actual, prepareSessionForExecutorStart: vi.fn() };
});

vi.mock('./utils/spawn-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/spawn-executor.js')>();
  return { ...actual, spawnExecutor: vi.fn() };
});

vi.mock('./executor-tracking.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./executor-tracking.js')>();
  return {
    ...actual,
    markExecutorProcessExited: vi.fn(),
    trackExecutorProcess: vi.fn(),
  };
});

vi.mock('./termination-coordinator.js', () => ({
  requestExecutorTermination: vi.fn(async () => ({ status: 'condition_changed' })),
}));

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    createUserProcessEnvironment: vi.fn(),
    getBaseUrl: vi.fn(async () => 'https://agor.example.com'),
  };
});

vi.mock('@agor/core/unix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/unix')>();
  return {
    ...actual,
    getHomedirFromUsername: vi.fn((username: string) => `/home/${username}`),
    validateResolvedUnixUser: vi.fn(),
  };
});

const SESSION_ID = '019fd900-0000-7000-8000-000000000001' as SessionID;
const TASK_ID = '019fd900-0000-7000-8000-000000000002' as TaskID;
const OWNER_ID = '019fd900-0000-7000-8000-000000000003' as UserID;
const PROMPTER_ID = '019fd900-0000-7000-8000-000000000004' as UserID;

const owner = {
  user_id: OWNER_ID,
  email: 'owner@example.com',
  name: 'Owner A',
  unix_username: 'owner-a',
  role: 'member',
} as User;

const prompter = {
  user_id: PROMPTER_ID,
  email: 'prompter@example.com',
  name: 'Prompter B',
  unix_username: 'prompter-b',
  role: 'member',
} as User;

const oauthServer = (id: string, name: string): MCPServer =>
  ({
    mcp_server_id: id,
    name,
    transport: 'http',
    url: `https://${id}.example.com/mcp`,
    scope: 'global',
    source: 'user',
    enabled: true,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  }) as MCPServer;

function makeHarness() {
  const generateToken = vi.fn(async () => 'prompter-executor-jwt');
  const oauthLookup = vi.fn(async (_data: unknown, params: { user?: User }) => ({
    headers:
      params.user?.user_id === OWNER_ID
        ? {
            'oauth-required': { authorization: 'Bearer owner-secret' },
            'oauth-transient': { authorization: 'Bearer owner-secret' },
          }
        : {
            'oauth-required': { error: 'needs_reauth' },
            'oauth-transient': { error: 'connection_reset' },
          },
  }));
  const app = {
    sessionTokenService: { generateToken, revokeToken: vi.fn() },
    service(name: string) {
      if (name === 'mcp-servers/oauth-auth-headers') return { create: oauthLookup };
      throw new Error(`Unexpected service: ${name}`);
    },
  };
  const db = { run: vi.fn() };
  const ctx = {
    db,
    app,
    config: {
      execution: { unix_user_mode: 'delegated' },
      multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
    },
    daemonUrl: 'https://daemon.example.com',
  } as unknown as RegisterServicesContext;
  const handler = createExecuteHandler(ctx, {} as never, {} as never);
  return { app, handler, generateToken, oauthLookup };
}

describe('task creator executor launch context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prepareSessionForExecutorStart).mockResolvedValue({
      session_id: SESSION_ID,
      branch_id: 'branch-b',
      created_by: OWNER_ID,
      agentic_tool: 'claude-code',
      agentic_tool_preset_id: null,
      permission_config: { mode: 'default' },
      custom_context: null,
    } as Session);
    vi.mocked(createUserProcessEnvironment).mockImplementation(async (userId) => ({
      IDENTITY: String(userId),
    }));
    vi.mocked(spawnExecutor).mockReturnValue(undefined as never);
    vi.spyOn(UsersRepository.prototype, 'findById').mockImplementation(async (userId) =>
      getCurrentTenantId() === 'tenant-b' && userId === PROMPTER_ID ? prompter : undefined
    );
    vi.spyOn(BranchRepository.prototype, 'findById').mockImplementation(async () =>
      getCurrentTenantId() === 'tenant-b'
        ? ({ branch_id: 'branch-b', path: '/worktrees/tenant-b/feature' } as never)
        : undefined
    );
    vi.spyOn(SessionMCPServerRepository.prototype, 'listServers').mockResolvedValue([]);
    vi.spyOn(MCPServerRepository.prototype, 'findAll').mockResolvedValue([
      oauthServer('oauth-required', 'Needs B authentication'),
      oauthServer('oauth-transient', 'Temporarily unavailable'),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { path: 'direct', messageSource: undefined },
    { path: 'queued gateway', messageSource: 'gateway' as const },
  ])('uses task creator B for $path launches without exposing owner A state', async (input) => {
    const { handler, generateToken, oauthLookup } = makeHarness();

    await runWithTenantContext('tenant-b', () =>
      handler(
        SESSION_ID,
        {
          taskId: TASK_ID,
          prompterUserId: PROMPTER_ID,
          prompt: 'Original task prompt',
          messageSource: input.messageSource,
        },
        { user: owner, tenant: { tenant_id: 'tenant-b', source: 'auth_claim' } }
      )
    );

    expect(generateToken).toHaveBeenCalledWith(
      SESSION_ID,
      PROMPTER_ID,
      expect.objectContaining({ taskId: TASK_ID })
    );
    expect(createUserProcessEnvironment).toHaveBeenCalledWith(
      PROMPTER_ID,
      expect.anything(),
      undefined,
      false,
      undefined,
      SESSION_ID
    );
    expect(oauthLookup).toHaveBeenCalledWith(
      { mcp_server_ids: ['oauth-required', 'oauth-transient'] },
      expect.objectContaining({ provider: undefined, user: prompter })
    );

    const [payload, options] = vi.mocked(spawnExecutor).mock.calls[0];
    expect(payload).toMatchObject({
      sessionToken: 'prompter-executor-jwt',
      env: { IDENTITY: PROMPTER_ID, DAEMON_URL: 'https://daemon.example.com' },
      params: {
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        messageSource: input.messageSource,
      },
    });
    expect(payload.params.prompt).toContain('Needs B authentication');
    expect(payload.params.prompt).not.toContain('Temporarily unavailable');
    expect(JSON.stringify(payload)).not.toContain('owner-secret');
    expect(options).toMatchObject({ templateVariables: { unix_user: 'prompter-b' } });
    expect(options.asUser).toBeUndefined();
  });

  it('fails before token, environment, OAuth, or spawn when B is not in the active tenant', async () => {
    const { handler, generateToken, oauthLookup } = makeHarness();

    await expect(
      runWithTenantContext('tenant-a', () =>
        handler(
          SESSION_ID,
          {
            taskId: TASK_ID,
            prompterUserId: PROMPTER_ID,
            prompt: 'Cross-tenant attempt',
          },
          { user: owner, tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } }
        )
      )
    ).rejects.toThrow(`Task creator ${PROMPTER_ID} not found`);

    expect(generateToken).not.toHaveBeenCalled();
    expect(createUserProcessEnvironment).not.toHaveBeenCalled();
    expect(oauthLookup).not.toHaveBeenCalled();
    expect(spawnExecutor).not.toHaveBeenCalled();
  });

  it('keeps local launch tracking and exit containment scoped to the daemon app', async () => {
    const { app, handler } = makeHarness();

    await runWithTenantContext('tenant-b', () =>
      handler(
        SESSION_ID,
        { taskId: TASK_ID, prompterUserId: PROMPTER_ID, prompt: 'Run locally' },
        { user: owner, tenant: { tenant_id: 'tenant-b', source: 'auth_claim' } }
      )
    );

    const options = vi.mocked(spawnExecutor).mock.calls[0][1];
    await options.onSpawn?.({ pid: 4242 } as never, { mode: 'local' });
    await options.onExit?.(1, { mode: 'local' });

    expect(trackExecutorProcess).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, taskId: TASK_ID, pid: 4242 }),
      app
    );
    expect(markExecutorProcessExited).toHaveBeenCalledWith(SESSION_ID, 4242, app);
    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({ app, taskId: TASK_ID, absenceVerified: false })
    );
  });

  it('treats only an authoritative templated-launcher failure as absence proof', async () => {
    const { app, handler } = makeHarness();

    await runWithTenantContext('tenant-b', () =>
      handler(
        SESSION_ID,
        { taskId: TASK_ID, prompterUserId: PROMPTER_ID, prompt: 'Run remotely' },
        { user: owner, tenant: { tenant_id: 'tenant-b', source: 'auth_claim' } }
      )
    );

    const options = vi.mocked(spawnExecutor).mock.calls[0][1];
    await options.onExit?.(1, { mode: 'templated' });

    expect(markExecutorProcessExited).not.toHaveBeenCalled();
    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        taskId: TASK_ID,
        absenceVerified: true,
        expectedStatus: 'dispatching',
        requireExecutorDisconnected: true,
      })
    );
  });
});
