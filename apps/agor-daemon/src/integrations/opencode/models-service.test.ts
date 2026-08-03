import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import { runWithTenantContext, UsersRepository } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecutorCommand } from '../../utils/spawn-executor.js';
import { createOpenCodeModelsService, resolveOpenCodeCreateModelFallback } from './models-service';

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
  return {
    ...actual,
    UsersRepository: vi.fn(),
  };
});

vi.mock('@agor/core/unix', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/unix')>('@agor/core/unix');
  return {
    ...actual,
    getHomedirFromUsername: (username: string) => `/home/${username}`,
    validateResolvedUnixUser: vi.fn(),
  };
});

vi.mock('../../utils/spawn-executor.js', () => ({
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
const catalog = {
  runtimeVersion: '1.14.33',
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      availableForSelection: true,
      suggestedModel: 'gpt-5',
      models: [{ id: 'gpt-5', name: 'GPT-5', status: 'active' }],
    },
  ],
};

function service() {
  return createOpenCodeModelsService(db);
}

beforeEach(() => {
  vi.clearAllMocks();
  enabled.mockResolvedValue(true);
  loadConfig.mockReturnValue({
    execution: { unix_user_mode: 'simple', branch_rbac: true },
  } as never);
  usersRepository.mockImplementation(function repository() {
    return { findById: vi.fn(async () => ({ unix_username: 'alice' })) };
  } as never);
  runCommand.mockResolvedValue({ success: true, data: catalog });
});

describe('OpenCode model catalog service', () => {
  it('requires the authenticated subject and accepts no target identity or scope', async () => {
    await runWithTenantContext('tenant-a', async () => {
      await expect(service().find()).rejects.toThrow(/sign in/i);
      await expect(
        service().find({
          ...params,
          query: { user_id: 'another-user', path: '/private', branch_id: 'branch-1' },
        } as never)
      ).rejects.toThrow(/does not accept query parameters/i);
    });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it('requests the user-scoped known catalog without branch or credential data', async () => {
    const result = await runWithTenantContext('tenant-a', () => service().find(params));

    expect(result).toEqual(catalog);
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agentic-tool.invoke',
        params: {
          tool: 'opencode',
          request: {
            operation: 'read-model-catalog',
          },
        },
      }),
      expect.any(Object)
    );
  });

  it('turns the catalog suggestion into an exact create-time fallback', async () => {
    runCommand.mockResolvedValue({
      success: true,
      data: {
        ...catalog,
        suggestedSelection: { providerId: 'openai', modelId: 'gpt-5' },
      },
    });

    const fallback = await runWithTenantContext('tenant-a', () =>
      resolveOpenCodeCreateModelFallback(db, params)
    );

    expect(fallback).toEqual({ mode: 'exact', provider: 'openai', model: 'gpt-5' });
  });

  it('routes identical user IDs in different tenants to isolated opaque namespaces', async () => {
    const seen: string[] = [];
    runCommand.mockImplementation(async (payload) => {
      seen.push(String((payload.agenticToolContext as { dataHome?: string }).dataHome));
      return { success: true, data: catalog };
    });

    await runWithTenantContext('tenant-a', () => service().find(params));
    await runWithTenantContext('tenant-b', () => service().find(params));

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.join(' ')).not.toMatch(/tenant-a|tenant-b|same-user/);
  });

  it('does not forward daemon provider credentials or leak executor failure details', async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-cross';
    runCommand.mockResolvedValue({
      success: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'secret must-not-cross at /home/alice/private',
      },
    });
    try {
      await runWithTenantContext('tenant-a', async () => {
        await expect(service().find(params)).rejects.toThrow(
          'OpenCode model catalog could not be loaded. Try again.'
        );
      });
      expect(runCommand.mock.calls[0]?.[1]?.env).not.toHaveProperty('OPENAI_API_KEY');

      runCommand.mockRejectedValue(new Error('must-not-cross at /home/alice/private'));
      await runWithTenantContext('tenant-a', async () => {
        await expect(service().find(params)).rejects.toThrow(
          'OpenCode model catalog could not be loaded. Try again.'
        );
      });
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });
});
