import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => undefined),
  resolveApiKey: vi.fn(),
}));

vi.mock('@agor/core/config', () => configMocks);

import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { TaskID, UserID } from '@agor/core/types';
import { ConfigService } from './config.js';

describe('ConfigService.resolveApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('allows executor service accounts and resolves for the task creator', async () => {
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
});
