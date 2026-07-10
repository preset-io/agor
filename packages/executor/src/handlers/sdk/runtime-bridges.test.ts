import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const repos = {
    branches: {},
    mcpOAuthAuthHeaders: {},
    mcpServers: {},
    messages: {},
    messagesService: {},
    repos: {},
    sessionMCP: {},
    sessions: {},
    sessionsService: {},
    tasksService: {},
    tasksStreamingService: {},
    users: {},
  };

  return {
    copilotPromptService: vi.fn(function MockCopilotPromptService() {}),
    geminiPromptService: vi.fn(function MockGeminiPromptService() {}),
    executeToolTask: vi.fn(async (params) => {
      params.createTool(repos, 'api-key', false);
    }),
  };
});

vi.mock('../../sdk-handlers/copilot/prompt-service.js', () => ({
  CopilotPromptService: mocks.copilotPromptService,
}));
vi.mock('../../sdk-handlers/gemini/prompt-service.js', () => ({
  GeminiPromptService: mocks.geminiPromptService,
}));
vi.mock('./base-executor.js', () => ({ executeToolTask: mocks.executeToolTask }));

import { executeCopilotTask } from './copilot.js';
import { executeGeminiTask } from './gemini.js';

describe('native runtime bridges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['copilot', executeCopilotTask, mocks.copilotPromptService],
    ['gemini', executeGeminiTask, mocks.geminiPromptService],
  ] as const)('forwards runtime through the %s tool to its prompt service', async (_, run, service) => {
    const runtime = { pulse: vi.fn() };
    const client = {
      service: vi.fn(() => ({ emit: vi.fn() })),
    };

    await run({
      client: client as never,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: 'review',
      abortController: new AbortController(),
      runtime,
    });

    expect(service).toHaveBeenCalledOnce();
    expect(service.mock.calls[0]?.at(-1)).toBe(runtime);
  });
});
