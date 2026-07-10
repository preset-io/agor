import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  codexTool: vi.fn(function MockCodexTool() {}),
  executeToolTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../sdk-handlers/codex/index.js', () => ({ CodexTool: mocks.codexTool }));
vi.mock('./base-executor.js', () => ({ executeToolTask: mocks.executeToolTask }));

import { executeCodexTask } from './codex.js';

describe('Codex SDK handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the executor runtime through the production tool factory', async () => {
    const runtime = { pulse: vi.fn() };
    await executeCodexTask({
      client: {} as never,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: 'review',
      abortController: new AbortController(),
      runtime,
    });

    const execution = mocks.executeToolTask.mock.calls[0]?.[0];
    expect(execution.runtime).toBe(runtime);

    execution.createTool(
      {
        messages: {},
        sessions: {},
        sessionMCP: {},
        branches: {},
        repos: {},
        messagesService: {},
        tasksService: {},
        tasksStreamingService: {},
        mcpServers: {},
        users: {},
        mcpOAuthAuthHeaders: {},
      },
      'api-key',
      false
    );

    expect(mocks.codexTool.mock.calls[0]?.at(-1)).toBe(runtime);
  });
});
