import { TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tool = {
    executeTask: vi.fn().mockResolvedValue({ status: 'completed' }),
    setSessionContext: vi.fn(),
  };
  const repos = {
    branches: { findById: vi.fn() },
    mcpOAuthAuthHeaders: {},
    mcpServers: {},
    messagesService: { create: vi.fn().mockResolvedValue({}) },
    sessionMCP: {},
  };
  return {
    commitExecutorTerminalOutcome: vi.fn(async (client, runtime, taskId, patch) => {
      await runtime.flush?.();
      return client.service('tasks').patch(taskId, patch);
    }),
    createFeathersBackedRepositories: vi.fn(() => repos),
    createRuntimeAwareStreamingCallbacks: vi.fn((callbacks) => callbacks),
    createStreamingCallbacks: vi.fn(() => ({
      onStreamChunk: vi.fn(),
      onStreamEnd: vi.fn(),
      onStreamError: vi.fn(),
      onStreamStart: vi.fn(),
    })),
    openCodeTool: vi.fn(function MockOpenCodeTool() {
      return tool;
    }),
    repos,
    tool,
  };
});

vi.mock('../../db/feathers-repositories.js', () => ({
  createFeathersBackedRepositories: mocks.createFeathersBackedRepositories,
}));
vi.mock('../../sdk-handlers/opencode/index.js', () => ({ OpenCodeTool: mocks.openCodeTool }));
vi.mock('./base-executor.js', () => ({
  commitExecutorTerminalOutcome: mocks.commitExecutorTerminalOutcome,
  createRuntimeAwareStreamingCallbacks: mocks.createRuntimeAwareStreamingCallbacks,
  createStreamingCallbacks: mocks.createStreamingCallbacks,
}));

import { executeOpenCodeTask } from './opencode.js';

describe('OpenCode SDK handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tool.executeTask.mockResolvedValue({ status: 'completed' });
  });

  it('forwards the executor runtime to the native event observer', async () => {
    const tasksPatch = vi.fn().mockResolvedValue({});
    const runtime = { pulse: vi.fn(), flush: vi.fn().mockResolvedValue(true) };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'sessions') {
          return {
            get: vi.fn().mockResolvedValue({
              branch_id: undefined,
              mcp_token: 'mcp-token',
              model_config: {},
              sdk_session_id: 'opencode-session-1',
              title: 'OpenCode session',
            }),
          };
        }
        if (name === 'messages') {
          return { find: vi.fn().mockResolvedValue([]) };
        }
        if (name === 'tasks') {
          return { patch: tasksPatch };
        }
        throw new Error(`Unexpected service: ${name}`);
      }),
    };

    await executeOpenCodeTask({
      client: client as never,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: 'review',
      abortController: new AbortController(),
      runtime,
    });

    expect(mocks.openCodeTool.mock.calls[0]?.at(-1)).toBe(runtime);
    expect(mocks.tool.executeTask).toHaveBeenCalled();
    expect(tasksPatch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: TaskStatus.COMPLETED })
    );
    expect(runtime.flush).toHaveBeenCalledOnce();
    expect(runtime.flush.mock.invocationCallOrder[0]).toBeLessThan(
      tasksPatch.mock.invocationCallOrder[0]
    );
  });
});
