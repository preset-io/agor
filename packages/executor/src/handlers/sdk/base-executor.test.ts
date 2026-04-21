import { describe, expect, it, vi } from 'vitest';
import { executeToolTask } from './base-executor.js';

interface FakeService {
  create?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  patch?: ReturnType<typeof vi.fn>;
  find?: ReturnType<typeof vi.fn>;
}

function createClient(services: Record<string, FakeService>) {
  return {
    service(name: string) {
      const service = services[name];
      if (!service) {
        throw new Error(`Missing fake service: ${name}`);
      }
      return service;
    },
  } as any;
}

describe('executeToolTask native auth context', () => {
  it('uses daemon-provided auth context without calling secret-resolution services', async () => {
    const services = {
      sessions: {
        get: vi.fn().mockResolvedValue({}),
      },
      messages: {
        find: vi.fn(),
        create: vi.fn(),
      },
      tasks: {
        patch: vi.fn().mockResolvedValue({}),
      },
      '/tasks/streaming': {
        create: vi.fn(),
      },
    };
    const createTool = vi.fn().mockReturnValue({
      executePromptWithStreaming: vi.fn().mockResolvedValue({
        userMessageId: 'msg-user',
        assistantMessageIds: ['msg-assistant'],
      }),
    });

    await executeToolTask({
      client: createClient(services),
      sessionId: 'session-a' as never,
      taskId: 'task-a' as never,
      prompt: 'hi',
      abortController: new AbortController(),
      apiKeyEnvVar: 'OPENAI_API_KEY',
      toolName: 'codex',
      authContext: {
        apiKeyEnvVar: 'OPENAI_API_KEY',
        apiKey: undefined,
        source: 'none',
        useNativeAuth: true,
        nativeAuthContext: {
          stableCodexHome: '/tmp/.agor/codex/users/user-a',
        },
      },
      createTool,
    });

    expect(createTool).toHaveBeenCalledWith(
      expect.anything(),
      '',
      true,
      expect.objectContaining({
        stableCodexHome: '/tmp/.agor/codex/users/user-a',
      })
    );
  });

  it('passes the daemon-resolved per-user Codex home into native Codex runs', async () => {
    const services = {
      'config/resolve-api-key': {
        create: vi.fn().mockResolvedValue({
          apiKey: undefined,
          source: 'none',
          useNativeAuth: true,
        }),
      },
      'codex-auth-status': {
        get: vi.fn().mockResolvedValue({
          codexHome: '/tmp/.agor/codex/users/user-a',
        }),
      },
      sessions: {
        get: vi.fn().mockResolvedValue({}),
      },
      messages: {
        find: vi.fn(),
        create: vi.fn(),
      },
      tasks: {
        patch: vi.fn().mockResolvedValue({}),
      },
      '/tasks/streaming': {
        create: vi.fn(),
      },
    };
    const createTool = vi.fn().mockReturnValue({
      executePromptWithStreaming: vi.fn().mockResolvedValue({
        userMessageId: 'msg-user',
        assistantMessageIds: ['msg-assistant'],
      }),
    });

    await executeToolTask({
      client: createClient(services),
      sessionId: 'session-a' as never,
      taskId: 'task-a' as never,
      prompt: 'hi',
      abortController: new AbortController(),
      apiKeyEnvVar: 'OPENAI_API_KEY',
      toolName: 'codex',
      authContext: {
        apiKeyEnvVar: 'OPENAI_API_KEY',
        apiKey: undefined,
        source: 'none',
        useNativeAuth: true,
        nativeAuthContext: {
          stableCodexHome: '/tmp/.agor/codex/users/user-a',
        },
      },
      createTool,
    });

    expect(createTool).toHaveBeenCalledWith(
      expect.anything(),
      '',
      true,
      expect.objectContaining({
        stableCodexHome: '/tmp/.agor/codex/users/user-a',
      })
    );
  });

  it('threads distinct native homes for separate users through separate daemon clients', async () => {
    const createTool = vi.fn().mockReturnValue({
      executePromptWithStreaming: vi.fn().mockResolvedValue({
        userMessageId: 'msg-user',
        assistantMessageIds: ['msg-assistant'],
      }),
    });

    const makeServices = (stableCodexHome: string) => ({
      'config/resolve-api-key': {
        create: vi.fn().mockResolvedValue({
          apiKey: undefined,
          source: 'none',
          useNativeAuth: true,
        }),
      },
      'codex-auth-status': {
        get: vi.fn().mockResolvedValue({
          codexHome: stableCodexHome,
        }),
      },
      sessions: {
        get: vi.fn().mockResolvedValue({}),
      },
      messages: {
        find: vi.fn(),
        create: vi.fn(),
      },
      tasks: {
        patch: vi.fn().mockResolvedValue({}),
      },
      '/tasks/streaming': {
        create: vi.fn(),
      },
    });

    await executeToolTask({
      client: createClient(makeServices('/tmp/.agor/codex/users/user-a')),
      sessionId: 'session-a' as never,
      taskId: 'task-a' as never,
      prompt: 'hi',
      abortController: new AbortController(),
      apiKeyEnvVar: 'OPENAI_API_KEY',
      toolName: 'codex',
      authContext: {
        apiKeyEnvVar: 'OPENAI_API_KEY',
        apiKey: undefined,
        source: 'none',
        useNativeAuth: true,
        nativeAuthContext: {
          stableCodexHome: '/tmp/.agor/codex/users/user-a',
        },
      },
      createTool,
    });

    await executeToolTask({
      client: createClient(makeServices('/tmp/.agor/codex/users/user-b')),
      sessionId: 'session-b' as never,
      taskId: 'task-b' as never,
      prompt: 'hi',
      abortController: new AbortController(),
      apiKeyEnvVar: 'OPENAI_API_KEY',
      toolName: 'codex',
      authContext: {
        apiKeyEnvVar: 'OPENAI_API_KEY',
        apiKey: undefined,
        source: 'none',
        useNativeAuth: true,
        nativeAuthContext: {
          stableCodexHome: '/tmp/.agor/codex/users/user-b',
        },
      },
      createTool,
    });

    expect(createTool).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      '',
      true,
      expect.objectContaining({
        stableCodexHome: '/tmp/.agor/codex/users/user-a',
      })
    );
    expect(createTool).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      '',
      true,
      expect.objectContaining({
        stableCodexHome: '/tmp/.agor/codex/users/user-b',
      })
    );
  });
});
