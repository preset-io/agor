import { resolveApiKey } from '@agor/core/config';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigResolveApiKeyService } from './config-resolve-api-key.js';

vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return {
    ...actual,
    resolveApiKey: vi.fn(),
  };
});

describe('ConfigResolveApiKeyService', () => {
  const resolveApiKeyMock = vi.mocked(resolveApiKey);
  const createParams = (
    userId?: UserID,
    extras: Partial<AuthenticatedParams['user']> = {}
  ): AuthenticatedParams => ({
    user: userId
      ? {
          user_id: userId,
          email: `${userId}@example.com`,
          role: 'member',
          ...extras,
        }
      : undefined,
  });

  beforeEach(() => {
    resolveApiKeyMock.mockReset();
  });

  it('requires authentication', async () => {
    const service = new ConfigResolveApiKeyService({} as never, { get: vi.fn() });

    await expect(service.create({ taskId: 'task-123', keyName: 'OPENAI_API_KEY' })).rejects.toThrow(
      NotAuthenticated
    );
  });

  it('requires taskId', async () => {
    const service = new ConfigResolveApiKeyService({} as never, { get: vi.fn() });

    await expect(
      service.create({ keyName: 'OPENAI_API_KEY' }, createParams('user-123'))
    ).rejects.toThrow(BadRequest);
  });

  it('requires keyName', async () => {
    const service = new ConfigResolveApiKeyService({} as never, { get: vi.fn() });

    await expect(service.create({ taskId: 'task-123' }, createParams('user-123'))).rejects.toThrow(
      BadRequest
    );
  });

  it('resolves an API key for the task owner', async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      apiKey: 'sk-user',
      source: 'user',
      useNativeAuth: false,
      decryptionFailed: false,
    });
    const tasksService = {
      get: vi.fn().mockResolvedValue({ created_by: 'user-123' }),
    };
    const service = new ConfigResolveApiKeyService({} as never, tasksService);

    await expect(
      service.create({ taskId: 'task-123', keyName: 'OPENAI_API_KEY' }, createParams('user-123'))
    ).resolves.toEqual({
      apiKey: 'sk-user',
      source: 'user',
      useNativeAuth: false,
    });

    expect(tasksService.get).toHaveBeenCalledWith('task-123', { provider: undefined });
    expect(resolveApiKeyMock).toHaveBeenCalledWith('OPENAI_API_KEY', {
      userId: 'user-123',
      db: expect.anything(),
    });
  });

  it('forbids resolving another user task', async () => {
    const service = new ConfigResolveApiKeyService({} as never, {
      get: vi.fn().mockResolvedValue({ created_by: 'user-456' }),
    });

    await expect(
      service.create({ taskId: 'task-123', keyName: 'OPENAI_API_KEY' }, createParams('user-123'))
    ).rejects.toThrow(Forbidden);
  });

  it('allows service accounts to resolve by task owner', async () => {
    resolveApiKeyMock.mockResolvedValueOnce({
      apiKey: null,
      source: 'none',
      useNativeAuth: true,
      decryptionFailed: false,
    });
    const service = new ConfigResolveApiKeyService({} as never, {
      get: vi.fn().mockResolvedValue({ created_by: 'user-456' }),
    });

    await expect(
      service.create(
        { taskId: 'task-123', keyName: 'OPENAI_API_KEY' },
        createParams('executor', { _isServiceAccount: true })
      )
    ).resolves.toEqual({
      apiKey: null,
      source: 'native',
      useNativeAuth: true,
    });
  });

  it('rejects missing tasks without leaking existence', async () => {
    const service = new ConfigResolveApiKeyService({} as never, {
      get: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.create({ taskId: 'task-123', keyName: 'OPENAI_API_KEY' }, createParams('user-123'))
    ).rejects.toThrow(Forbidden);
  });

  it('maps task lookup not-found errors to a forbidden response', async () => {
    const service = new ConfigResolveApiKeyService({} as never, {
      get: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { name: 'NotFound' })),
    });

    await expect(
      service.create({ taskId: 'task-123', keyName: 'OPENAI_API_KEY' }, createParams('user-123'))
    ).rejects.toThrow(Forbidden);
  });
});
