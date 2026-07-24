import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import { runWithTenantContext, UsersRepository } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecutorCommand } from '../utils/spawn-executor.js';
import { createOpenCodeAuthService } from './opencode-auth';

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
  return { ...actual, UsersRepository: vi.fn() };
});

vi.mock('@agor/core/unix', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/unix')>('@agor/core/unix');
  return {
    ...actual,
    getHomedirFromUsername: (username: string) => `/home/${username}`,
    validateResolvedUnixUser: vi.fn(),
  };
});

vi.mock('../utils/spawn-executor.js', () => ({
  runExecutorCommand: vi.fn(),
}));

const runCommand = vi.mocked(runExecutorCommand);
const enabled = vi.mocked(isTenantAgenticToolEnabled);
const loadConfig = vi.mocked(loadConfigSync);
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
      configured: false,
      status: 'disconnected',
      authMethods: [],
    },
  ],
};

function service() {
  return createOpenCodeAuthService(db);
}

beforeEach(() => {
  vi.clearAllMocks();
  enabled.mockResolvedValue(true);
  loadConfig.mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  usersRepository.mockImplementation(function repository() {
    return { findById: vi.fn(async () => ({ unix_username: 'alice' })) };
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
        command: 'opencode.auth',
        params: {
          operation: 'connect-api-key',
          providerId: 'kimi-for-coding',
          apiKey: 'synthetic-key',
          metadata: { region: 'us', accountId: 'synthetic-account' },
        },
      }),
      expect.any(Object)
    );
  });

  it('routes identical user IDs in different tenants to different opaque namespaces', async () => {
    const seen: string[] = [];
    runCommand.mockImplementation(async (payload) => {
      seen.push(String(payload.dataHome));
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

  it('serializes all mutations for one namespace while another tenant remains independent', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runCommand
      .mockImplementationOnce(async () => {
        await firstGate;
        return { success: true, data: discovery };
      })
      .mockResolvedValue({ success: true, data: discovery });

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

  it('reports logical isolation in simple and insulated modes and OS isolation only in strict', async () => {
    const modes = [
      { mode: 'simple', boundary: 'logical' },
      { mode: 'insulated', boundary: 'logical', executor_unix_user: 'agor_executor' },
      { mode: 'strict', boundary: 'os' },
    ] as const;

    for (const { mode, boundary, executor_unix_user } of modes) {
      loadConfig.mockReturnValue({
        execution: { unix_user_mode: mode, executor_unix_user },
      } as never);
      const result = await runWithTenantContext('tenant-a', () => service().find(params));
      expect(result.isolation).toEqual({ mode, boundary });
    }
  });
});
