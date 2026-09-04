import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import {
  BranchRepository,
  requireCurrentTenantId,
  runWithTenantContext,
  UsersRepository,
} from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeAuthService } from './auth-service';
import { startOpenCodeOAuthExecutor } from './oauth-executor.js';

const containment = vi.hoisted(() => ({
  release: vi.fn(),
  reserve: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../../executor-tracking.js', () => ({
  releaseExecutorContainmentFenceIntent: containment.release,
  reserveExecutorContainmentFence: containment.reserve,
  verifyExecutorContainmentFence: containment.verify,
}));

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return {
    ...actual,
    isTenantAgenticToolEnabled: vi.fn(),
    loadConfigSync: vi.fn(),
  };
});

vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return { ...actual, BranchRepository: vi.fn(), UsersRepository: vi.fn() };
});

vi.mock('@agor/core/unix', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/unix')>('@agor/core/unix');
  return {
    ...actual,
    getHomedirFromUsername: (username: string) => `/home/${username}`,
    validateResolvedUnixUser: vi.fn(),
  };
});

const runCommand = vi.hoisted(() => vi.fn());
vi.mock('../../utils/spawn-executor.js', () => ({
  requestExecutor: runCommand,
  startContainedExecutorCommand: (payload: unknown, options: unknown) => ({
    result: runCommand(payload, options),
    verifyAbsence: vi.fn(async () => true),
    retainContainmentFence: vi.fn(async () => undefined),
  }),
}));

vi.mock('./oauth-executor.js', () => ({
  startOpenCodeOAuthExecutor: vi.fn(),
}));

const startOAuth = vi.mocked(startOpenCodeOAuthExecutor);
const enabled = vi.mocked(isTenantAgenticToolEnabled);
const loadConfig = vi.mocked(loadConfigSync);
const branchRepository = vi.mocked(BranchRepository);
const usersRepository = vi.mocked(UsersRepository);
const db = { run: vi.fn() } as never;
const params = {
  user: { user_id: 'same-user', email: 'user@example.com', role: 'member' },
} as never;

const discovery = {
  runtime: 'available',
  runtimeVersion: '1.14.33',
  providers: [
    {
      id: 'kimi-for-coding',
      name: 'Kimi for Coding',
      runtimeAvailable: false,
      credentialPresence: 'absent',
      authMethods: [],
      models: [],
    },
  ],
};

function service() {
  return createOpenCodeAuthService(db, loadConfigSync());
}

beforeEach(() => {
  vi.clearAllMocks();
  containment.release.mockResolvedValue(undefined);
  containment.reserve.mockResolvedValue('test-intent');
  containment.verify.mockResolvedValue(true);
  enabled.mockResolvedValue(true);
  loadConfig.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  usersRepository.mockImplementation(function repository() {
    return { findById: vi.fn(async () => ({ unix_username: 'alice' })) };
  } as never);
  branchRepository.mockImplementation(function repository() {
    return {
      findById: vi.fn(async () => ({ id: 'branch-1', path: '/worktrees/branch-1' })),
      resolveUserAccess: vi.fn(async () => ({ can: 'view', fs_access: 'read' })),
    };
  } as never);
  runCommand.mockResolvedValue({ success: true, data: discovery });
});

describe('OpenCode provider auth service', () => {
  it('requires an authenticated caller before resolving a credential namespace', async () => {
    await runWithTenantContext('tenant-a', async () => {
      await expect(service().find()).rejects.toThrow(/sign in/i);
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('does not copy daemon provider credentials into the native auth executor', async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.OPENAI_API_KEY = 'must-not-cross';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'must-not-cross';
    try {
      await runWithTenantContext('tenant-a', () => service().find(params));
      const options = runCommand.mock.calls[0]?.[1];
      expect(options?.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(options?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken;
    }
  });

  it('authorizes branch-aware discovery and forwards only the resolved directory', async () => {
    loadConfig.mockReturnValue({
      execution: { unix_user_mode: 'simple', branch_rbac: true },
    } as never);

    await runWithTenantContext('tenant-a', () =>
      service().find({ ...params, query: { branch_id: 'branch-1' } } as never)
    );

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          tool: 'opencode',
          request: { operation: 'discover', directory: '/worktrees/branch-1' },
        },
      }),
      expect.any(Object)
    );
  });

  it('rejects unsupported discovery scope and branch access before executor activity', async () => {
    loadConfig.mockReturnValue({
      execution: { unix_user_mode: 'simple', branch_rbac: true },
    } as never);
    branchRepository.mockImplementationOnce(function repository() {
      return {
        findById: vi.fn(async () => ({ id: 'branch-1', path: '/worktrees/branch-1' })),
        resolveUserAccess: vi.fn(async () => ({ can: 'none', fs_access: 'none' })),
      };
    } as never);

    await runWithTenantContext('tenant-a', async () => {
      await expect(
        service().find({ ...params, query: { user_id: 'other' } } as never)
      ).rejects.toThrow(/only an optional branch ID/i);
      await expect(
        service().find({ ...params, query: { branch_id: 'branch-1' } } as never)
      ).rejects.toThrow(/not authorized/i);
    });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it('does not resolve another tenant branch with the same identifier', async () => {
    loadConfig.mockReturnValue({
      execution: { unix_user_mode: 'simple', branch_rbac: true },
    } as never);
    branchRepository.mockImplementation(function repository() {
      return {
        findById: vi.fn(async () =>
          requireCurrentTenantId() === 'tenant-a'
            ? { id: 'shared-id', path: '/worktrees/tenant-a' }
            : undefined
        ),
        resolveUserAccess: vi.fn(async () => ({
          can: 'view',
          fs_access: 'read',
          is_owner: false,
        })),
      };
    } as never);

    await runWithTenantContext('tenant-a', () =>
      service().find({ ...params, query: { branch_id: 'shared-id' } } as never)
    );
    await runWithTenantContext('tenant-b', async () => {
      await expect(
        service().find({ ...params, query: { branch_id: 'shared-id' } } as never)
      ).rejects.toThrow(/not authorized/i);
    });

    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('derives the subject from the authenticated caller and rejects target identity fields', async () => {
    await runWithTenantContext('tenant-a', async () => {
      await expect(
        service().create(
          {
            providerId: 'kimi-for-coding',
            apiKey: 'synthetic-key',
            userId: 'another-user',
          } as never,
          params
        )
      ).rejects.toThrow(/unsupported field/i);
    });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it('forwards native API prompt values as auth metadata', async () => {
    await runWithTenantContext('tenant-a', () =>
      service().create(
        {
          providerId: 'kimi-for-coding',
          apiKey: 'synthetic-key',
          metadata: { region: 'us', accountId: 'synthetic-account' },
        },
        params
      )
    );

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agentic-tool.invoke',
        params: {
          tool: 'opencode',
          request: {
            operation: 'connect-api-key',
            providerId: 'kimi-for-coding',
            apiKey: 'synthetic-key',
            metadata: { region: 'us', accountId: 'synthetic-account' },
          },
        },
      }),
      expect.any(Object)
    );
  });

  it('routes identical user IDs in different tenants to different opaque namespaces', async () => {
    const seen: string[] = [];
    runCommand.mockImplementation(async (payload) => {
      seen.push(String((payload.agenticToolContext as { dataHome?: string }).dataHome));
      return { success: true, data: discovery };
    });

    await runWithTenantContext('tenant-a', () => service().find(params));
    await runWithTenantContext('tenant-b', () => service().find(params));

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.join(' ')).not.toContain('tenant-a');
    expect(seen.join(' ')).not.toContain('tenant-b');
    expect(seen.join(' ')).not.toContain('same-user');
  });

  it('rejects hosted auth-resolved tenancy before executor or provider activity', async () => {
    loadConfig.mockReturnValue({
      multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
    } as never);

    await runWithTenantContext('tenant-a', async () => {
      await expect(service().find(params)).rejects.toThrow(/hosted multi-tenant/i);
    });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects delegated mode before executor or provider activity', async () => {
    loadConfig.mockReturnValue({
      execution: { unix_user_mode: 'delegated' },
    } as never);

    await runWithTenantContext('tenant-a', async () => {
      await expect(service().find(params)).rejects.toThrow(
        /unavailable in delegated execution mode/i
      );
    });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it('serializes all mutations for one namespace while another tenant remains independent', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const present = {
      ...discovery,
      providers: [
        {
          ...discovery.providers[0],
          credentialPresence: 'present' as const,
        },
      ],
    };
    let firstMutation = true;
    runCommand.mockImplementation(async (payload) => {
      if (payload.params.request.operation === 'connect-api-key' && firstMutation) {
        firstMutation = false;
        await firstGate;
      }
      return {
        success: true,
        data: payload.params.request.operation === 'discover' ? present : discovery,
      };
    });

    const first = runWithTenantContext('tenant-a', () =>
      service().create({ providerId: 'kimi-for-coding', apiKey: 'key-1' }, params)
    );
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    const second = runWithTenantContext('tenant-a', () =>
      service().remove('kimi-for-coding', params)
    );
    const independent = runWithTenantContext('tenant-b', () =>
      service().remove('kimi-for-coding', params)
    );

    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(2));
    releaseFirst();
    await Promise.all([first, second, independent]);
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it('returns a safe error when the runtime cannot prove a saved credential exists', async () => {
    runCommand.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'OPENCODE_AUTH_FAILED',
        message: 'OpenCode provider operation failed without exposing credential details.',
      },
    });

    await runWithTenantContext('tenant-a', async () => {
      await expect(service().remove('kimi-for-coding', params)).rejects.toThrow(
        /provider operation failed/i
      );
    });

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          tool: 'opencode',
          request: { operation: 'disconnect', providerId: 'kimi-for-coding' },
        },
      }),
      expect.any(Object)
    );
  });

  it('removes a known saved Zen credential even when Zen remains runtime-available', async () => {
    const present = {
      ...discovery,
      providers: [
        {
          ...discovery.providers[0],
          id: 'opencode',
          name: 'OpenCode Zen',
          runtimeAvailable: true,
          credentialPresence: 'present' as const,
        },
      ],
    };
    const removed = {
      ...present,
      providers: [
        {
          ...present.providers[0],
          credentialPresence: 'absent' as const,
        },
      ],
    };
    runCommand.mockResolvedValueOnce({ success: true, data: removed });

    const result = await runWithTenantContext('tenant-a', () =>
      service().remove('opencode', params)
    );

    expect(runCommand.mock.calls.map(([payload]) => payload.params.request)).toEqual([
      { operation: 'disconnect', providerId: 'opencode' },
    ]);
    expect(result.providers[0]).toMatchObject({
      id: 'opencode',
      runtimeAvailable: true,
      credentialPresence: 'absent',
    });
  });

  it('keeps one OAuth attempt on one executor through authorize and callback states', async () => {
    let emit!: Parameters<typeof startOpenCodeOAuthExecutor>[3];
    let finish!: (value: {
      success: boolean;
      data?: unknown;
      error?: { code: string; message: string };
    }) => void;
    startOAuth.mockImplementation((_dataHome, _request, _options, onEvent) => {
      emit = onEvent;
      return {
        verifyAbsence: vi.fn(async () => true),
        retainContainmentFence: vi.fn(async () => undefined),
        result: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel: vi.fn(),
        submitCode: vi.fn(),
      };
    });
    const authService = service();
    const pending = runWithTenantContext('tenant-a', () =>
      authService.create(
        {
          operation: 'connect-oauth',
          providerId: 'openai',
          method: 1,
          inputs: { region: 'us' },
        },
        params
      )
    );
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());

    emit({
      type: 'authorized',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto',
        instructions: 'Use the synthetic provider.',
      },
    });
    const started = await pending;
    expect(started).toMatchObject({
      providerId: 'openai',
      phase: 'awaiting_callback',
      authorization: { method: 'auto' },
    });
    emit({ type: 'callback-started' });
    expect(
      await runWithTenantContext('tenant-a', () =>
        authService.get((started as { attemptId: string }).attemptId, params)
      )
    ).toMatchObject({ phase: 'completing' });

    finish({
      success: true,
      data: {
        ...discovery,
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            runtimeAvailable: true,
            credentialPresence: 'present',
            authMethods: [],
          },
        ],
      },
    });
    await vi.waitFor(async () =>
      expect(
        (
          await runWithTenantContext('tenant-a', () =>
            authService.get((started as { attemptId: string }).attemptId, params)
          )
        ).phase
      ).toBe('configured')
    );
    expect(startOAuth).toHaveBeenCalledOnce();
    expect(startOAuth.mock.calls[0]?.[1]).toMatchObject({
      operation: 'connect-oauth',
      providerId: 'openai',
      method: 1,
      inputs: { region: 'us' },
    });
  });

  it('holds the namespace mutation slot for OAuth across providers while another tenant stays independent', async () => {
    let emit!: Parameters<typeof startOpenCodeOAuthExecutor>[3];
    let finish!: (value: { success: boolean; error: { code: string; message: string } }) => void;
    startOAuth.mockImplementation((_dataHome, _request, _options, onEvent) => {
      emit = onEvent;
      return {
        verifyAbsence: vi.fn(async () => true),
        retainContainmentFence: vi.fn(async () => undefined),
        result: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel: vi.fn(),
        submitCode: vi.fn(),
      };
    });
    runCommand.mockImplementation(async (payload) => ({
      success: true,
      data:
        payload.params.request.operation === 'discover'
          ? {
              ...discovery,
              providers: [
                {
                  ...discovery.providers[0],
                  credentialPresence: 'present' as const,
                },
              ],
            }
          : discovery,
    }));
    const authService = service();
    const oauth = runWithTenantContext('tenant-a', () =>
      authService.create({ operation: 'connect-oauth', providerId: 'openai', method: 1 }, params)
    );
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());
    emit({
      type: 'authorized',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto',
        instructions: 'Synthetic',
      },
    });
    await oauth;

    const blocked = runWithTenantContext('tenant-a', () =>
      authService.create({ providerId: 'kimi-for-coding', apiKey: 'key-1' }, params)
    );
    const independent = runWithTenantContext('tenant-b', () =>
      authService.remove('kimi-for-coding', params)
    );
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    expect(runCommand.mock.calls.map(([payload]) => payload.params.request)).toEqual([
      { operation: 'disconnect', providerId: 'kimi-for-coding' },
    ]);

    finish({
      success: false,
      error: { code: 'OPENCODE_AUTH_FAILED', message: 'safe' },
    });
    await Promise.all([blocked, independent]);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('isolates attempts by tenant and subject and cancels the full executor handle', async () => {
    let emit!: Parameters<typeof startOpenCodeOAuthExecutor>[3];
    let finish!: (value: { success: boolean; error: { code: string; message: string } }) => void;
    const cancel = vi.fn(async () => {
      const result = {
        success: false,
        error: { code: 'OPENCODE_OAUTH_CANCELLED', message: 'safe' },
      };
      finish(result);
      return result;
    });
    startOAuth.mockImplementation((_dataHome, _request, _options, onEvent) => {
      emit = onEvent;
      return {
        verifyAbsence: vi.fn(async () => true),
        retainContainmentFence: vi.fn(async () => undefined),
        result: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel,
        submitCode: vi.fn(),
      };
    });
    const authService = service();
    const pending = runWithTenantContext('tenant-a', () =>
      authService.create({ operation: 'connect-oauth', providerId: 'openai', method: 1 }, params)
    );
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());
    emit({
      type: 'authorized',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto',
        instructions: 'Synthetic',
      },
    });
    const started = (await pending) as { attemptId: string };

    await runWithTenantContext('tenant-b', async () => {
      await expect(authService.get(started.attemptId, params)).rejects.toThrow(/not found/i);
    });
    await runWithTenantContext('tenant-a', async () => {
      await expect(
        authService.get(started.attemptId, {
          user: { user_id: 'other-user', email: 'other@example.com', role: 'member' },
        } as never)
      ).rejects.toThrow(/not found/i);
    });
    const cancelled = await runWithTenantContext('tenant-a', () =>
      authService.patch(started.attemptId, { cancel: true }, params)
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancelled.phase).toBe('cancelled');
  });

  it('maps a bounded executor timeout to an expired attempt without exposing failure detail', async () => {
    let emit!: Parameters<typeof startOpenCodeOAuthExecutor>[3];
    let finish!: (value: {
      success: boolean;
      error: { code: string; message: string; details?: unknown };
    }) => void;
    startOAuth.mockImplementation((_dataHome, _request, _options, onEvent) => {
      emit = onEvent;
      return {
        verifyAbsence: vi.fn(async () => true),
        retainContainmentFence: vi.fn(async () => undefined),
        result: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel: vi.fn(),
        submitCode: vi.fn(),
      };
    });
    const authService = service();
    const pending = runWithTenantContext('tenant-a', () =>
      authService.create({ operation: 'connect-oauth', providerId: 'openai', method: 1 }, params)
    );
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());
    emit({
      type: 'authorized',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto',
        instructions: 'Synthetic',
      },
    });
    const started = (await pending) as { attemptId: string };
    finish({
      success: false,
      error: {
        code: 'OPENCODE_OAUTH_TIMEOUT',
        message: 'contains synthetic-secret and /private/path',
        details: { password: 'synthetic-password' },
      },
    });
    const terminal = await vi.waitFor(() =>
      runWithTenantContext('tenant-a', () => authService.get(started.attemptId, params))
    );
    await vi.waitFor(() =>
      expect(
        runWithTenantContext('tenant-a', () => authService.get(started.attemptId, params))
      ).resolves.toMatchObject({ phase: 'expired' })
    );
    expect(JSON.stringify(terminal)).not.toContain('synthetic-secret');
    expect(JSON.stringify(terminal)).not.toContain('/private/path');
    expect(JSON.stringify(terminal)).not.toContain('synthetic-password');
  });

  it('submits one code to the same attempt without storing or returning the secret', async () => {
    let emit!: Parameters<typeof startOpenCodeOAuthExecutor>[3];
    let finish!: (value: { success: boolean; error: { code: string; message: string } }) => void;
    const submitCode = vi.fn(async () => true);
    startOAuth.mockImplementation((_dataHome, _request, _options, onEvent) => {
      emit = onEvent;
      return {
        verifyAbsence: vi.fn(async () => true),
        retainContainmentFence: vi.fn(async () => undefined),
        result: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel: vi.fn(),
        submitCode,
      };
    });
    const authService = service();
    const pending = runWithTenantContext('tenant-a', () =>
      authService.create({ operation: 'connect-oauth', providerId: 'openai', method: 1 }, params)
    );
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());
    emit({
      type: 'authorized',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'code',
        instructions: 'Paste the code.',
      },
    });
    const started = (await pending) as { attemptId: string };

    const completing = await runWithTenantContext('tenant-a', () =>
      authService.patch(started.attemptId, { code: ' synthetic-secret-code ' }, params)
    );
    expect(submitCode).toHaveBeenCalledWith('synthetic-secret-code');
    expect(completing.phase).toBe('completing');
    expect(JSON.stringify(completing)).not.toContain('synthetic-secret-code');

    await runWithTenantContext('tenant-b', async () => {
      await expect(
        authService.patch(started.attemptId, { code: 'wrong-subject-code' }, params)
      ).rejects.toThrow(/not found/i);
    });
    expect(submitCode).toHaveBeenCalledOnce();
    finish({
      success: false,
      error: { code: 'OPENCODE_AUTH_FAILED', message: 'safe' },
    });
  });

  it('blocks every later namespace mutation until retained containment verifies absence', async () => {
    let emit!: Parameters<typeof startOpenCodeOAuthExecutor>[3];
    const cleanupFailure = {
      success: false,
      error: {
        code: 'OPENCODE_OAUTH_CLEANUP_UNVERIFIED',
        message: 'synthetic-secret password /private/path',
      },
    };
    let finish!: (value: typeof cleanupFailure) => void;
    const cancel = vi.fn(async () => {
      finish(cleanupFailure);
      return cleanupFailure;
    });
    containment.verify
      .mockReset()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const verifyAbsence = vi.fn(async () => false);
    const retainContainmentFence = vi.fn(async () => undefined);
    startOAuth.mockImplementation((_dataHome, _request, _options, onEvent) => {
      emit = onEvent;
      return {
        result: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel,
        submitCode: vi.fn(),
        verifyAbsence,
        retainContainmentFence,
      };
    });
    const authService = service();
    const pending = runWithTenantContext('tenant-a', () =>
      authService.create({ operation: 'connect-oauth', providerId: 'openai', method: 1 }, params)
    );
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());
    emit({
      type: 'authorized',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto',
        instructions: 'Synthetic',
      },
    });
    const started = (await pending) as { attemptId: string };

    const terminal = await runWithTenantContext('tenant-a', () =>
      authService.patch(started.attemptId, { cancel: true }, params)
    );
    expect(terminal.phase).toBe('failed');
    expect(terminal.phase).not.toBe('cancelled');
    await vi.waitFor(() => expect(containment.verify).toHaveBeenCalledTimes(2));

    await runWithTenantContext('tenant-a', async () => {
      const blockedApi = authService.create(
        { providerId: 'kimi-for-coding', apiKey: 'later-key' },
        params
      );
      await expect(blockedApi).rejects.toThrow(/cleanup could not be verified/i);
      const publicError = await blockedApi.catch((error) => error);
      expect(String(publicError)).not.toContain('synthetic-secret');
      expect(String(publicError)).not.toContain('/private/path');
      expect(String(publicError)).not.toContain('password');
      await expect(authService.remove('zhipuai-coding-plan', params)).rejects.toThrow(
        /cleanup could not be verified/i
      );
    });
    const blockedOAuth = await runWithTenantContext('tenant-a', () =>
      authService.create(
        { operation: 'connect-oauth', providerId: 'another-provider', method: 0 },
        params
      )
    );
    expect(blockedOAuth).toMatchObject({ providerId: 'another-provider', phase: 'failed' });
    expect(startOAuth).toHaveBeenCalledOnce();
    expect(retainContainmentFence).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();

    await expect(
      runWithTenantContext('tenant-a', () =>
        authService.create({ providerId: 'kimi-for-coding', apiKey: 'recovery-key' }, params)
      )
    ).resolves.toMatchObject({ runtime: 'available' });
    expect(containment.verify).toHaveBeenCalledTimes(7);
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('does not let an in-flight code submission reverse cancellation', async () => {
    let emit!: Parameters<typeof startOpenCodeOAuthExecutor>[3];
    let finish!: (value: { success: boolean; error: { code: string; message: string } }) => void;
    let releaseCode!: (accepted: boolean) => void;
    const submitCode = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCode = resolve;
        })
    );
    const cancelledResult = {
      success: false,
      error: { code: 'OPENCODE_OAUTH_CANCELLED', message: 'safe' },
    };
    const cancel = vi.fn(async () => {
      finish(cancelledResult);
      return cancelledResult;
    });
    startOAuth.mockImplementation((_dataHome, _request, _options, onEvent) => {
      emit = onEvent;
      return {
        verifyAbsence: vi.fn(async () => true),
        retainContainmentFence: vi.fn(async () => undefined),
        result: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel,
        submitCode,
      };
    });
    const authService = service();
    const pending = runWithTenantContext('tenant-a', () =>
      authService.create({ operation: 'connect-oauth', providerId: 'openai', method: 1 }, params)
    );
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());
    emit({
      type: 'authorized',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'code',
        instructions: 'Paste the code.',
      },
    });
    const started = (await pending) as { attemptId: string };
    const codePatch = runWithTenantContext('tenant-a', () =>
      authService.patch(started.attemptId, { code: 'synthetic-code' }, params)
    );
    await vi.waitFor(() => expect(submitCode).toHaveBeenCalledOnce());
    const cancellation = runWithTenantContext('tenant-a', () =>
      authService.patch(started.attemptId, { cancel: true }, params)
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    releaseCode(true);

    await expect(cancellation).resolves.toMatchObject({ phase: 'cancelled' });
    await expect(codePatch).resolves.toMatchObject({ phase: 'cancelled' });
  });

  it('cancels the same OAuth child after delayed fence attachment completes', async () => {
    let emit!: Parameters<typeof startOpenCodeOAuthExecutor>[3];
    let finish!: (value: { success: boolean; error: { code: string; message: string } }) => void;
    let releaseAttachment!: () => void;
    const cancelledResult = {
      success: false,
      error: { code: 'OPENCODE_OAUTH_CANCELLED', message: 'safe' },
    };
    const retainContainmentFence = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseAttachment = resolve;
        })
    );
    const cancel = vi.fn(async () => {
      expect(containment.release).toHaveBeenCalledWith(
        expect.stringMatching(/^opencode-native-state:/),
        'test-intent'
      );
      finish(cancelledResult);
      return cancelledResult;
    });
    startOAuth.mockImplementation((_dataHome, _request, _options, onEvent) => {
      emit = onEvent;
      return {
        verifyAbsence: vi.fn(async () => true),
        retainContainmentFence,
        result: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel,
        submitCode: vi.fn(),
      };
    });
    const authService = service();
    const pending = runWithTenantContext('tenant-a', () =>
      authService.create({ operation: 'connect-oauth', providerId: 'openai', method: 1 }, params)
    );
    await vi.waitFor(() => expect(retainContainmentFence).toHaveBeenCalledOnce());
    emit({
      type: 'authorized',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto',
        instructions: 'Synthetic',
      },
    });
    const started = (await pending) as { attemptId: string };

    const cancellation = runWithTenantContext('tenant-a', () =>
      authService.patch(started.attemptId, { cancel: true }, params)
    );
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();

    releaseAttachment();
    await expect(cancellation).resolves.toMatchObject({ phase: 'cancelled' });
    await expect(
      runWithTenantContext('tenant-a', () => authService.get(started.attemptId, params))
    ).resolves.toMatchObject({ phase: 'cancelled' });
    expect(startOAuth).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalled();
  });

  it('reports logical isolation for supported native modes', async () => {
    for (const mode of ['simple', 'sandbox'] as const) {
      loadConfig.mockReturnValue({ execution: { unix_user_mode: mode } } as never);
      const result = await runWithTenantContext('tenant-a', () => service().find(params));
      expect(result.isolation).toEqual({ mode, boundary: 'logical' });
    }
  });
});
