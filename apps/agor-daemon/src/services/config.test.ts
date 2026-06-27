import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => undefined),
  resolveApiKey: vi.fn(),
}));

vi.mock('@agor/core/config', () => configMocks);

import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { TaskID, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
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
        authentication: {
          payload: { type: 'executor-session', purpose: 'executor-task', task_id: 'task-1' },
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

  it('allows executor runtime tokens passed as explicit session-token proof', async () => {
    const service = new ConfigService({} as never);
    service.app = {
      sessionTokenService: {
        validateToken: vi.fn(async () => ({ task_id: 'task-1' })),
      },
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
      {
        taskId: 'task-1' as TaskID,
        keyName: 'OPENAI_API_KEY',
        tool: 'codex',
        executorSessionToken: 'executor-jwt',
      },
      {
        provider: 'socketio',
        user: { user_id: 'creator-1' },
      } as never
    );

    expect(result).toMatchObject({ apiKey: 'resolved-test-key', source: 'user' });
    expect(configMocks.resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', {
      userId: 'creator-1',
      db: {},
      tool: 'codex',
    });
  });

  it('recovers executor runtime scope from the verified access token when payload is absent', async () => {
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
    const accessToken = jwt.sign(
      {
        type: 'executor-session',
        purpose: 'executor-task',
        task_id: 'task-1',
      },
      'test-secret'
    );

    const result = await service.resolveApiKey(
      { taskId: 'task-1' as TaskID, keyName: 'OPENAI_API_KEY', tool: 'codex' },
      {
        provider: 'socketio',
        authentication: { accessToken },
        user: { user_id: 'creator-1' },
      } as never
    );

    expect(result).toMatchObject({ apiKey: 'resolved-test-key', source: 'user' });
    expect(configMocks.resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', {
      userId: 'creator-1',
      db: {},
      tool: 'codex',
    });
  });

  it('allows executor runtime tokens when Socket.io preserved scope fields without payload', async () => {
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
        authentication: { strategy: 'jwt' },
        user: { user_id: 'creator-1' },
        task_id: 'task-1',
        session_id: 'session-1',
        branch_id: 'branch-1',
      } as never
    );

    expect(result).toMatchObject({ apiKey: 'resolved-test-key', source: 'user' });
    expect(configMocks.resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY', {
      userId: 'creator-1',
      db: {},
      tool: 'codex',
    });
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
          authentication: {
            payload: { type: 'executor-session', purpose: 'executor-task', task_id: 'task-1' },
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
          authentication: {
            payload: { type: 'executor-session', purpose: 'executor-task', task_id: 'task-1' },
          },
        } as never
      )
    ).rejects.toBeInstanceOf(Forbidden);

    expect(configMocks.resolveApiKey).not.toHaveBeenCalled();
  });
});
