import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMcpServersForSession: vi.fn(),
}));

vi.mock('@agor/core/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/mcp')>()),
  getMcpServersForSession: mocks.getMcpServersForSession,
}));

import { CopilotPromptService } from './prompt-service.js';

describe('CopilotPromptService MCP identity scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMcpServersForSession.mockResolvedValue([]);
  });

  it('hydrates OAuth for the task creator while filtering definitions by session owner', async () => {
    const service = new CopilotPromptService(
      {} as never,
      {
        findById: vi.fn().mockResolvedValue({ created_by: 'session-owner' }),
      } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      {} as never,
      undefined,
      undefined,
      undefined,
      {
        get: vi.fn().mockResolvedValue({ created_by: 'task-creator' }),
      } as never,
      undefined,
      {} as never
    );

    await (
      service as unknown as {
        buildMcpServers(sessionId: string, taskId: string): Promise<Record<string, unknown>>;
      }
    ).buildMcpServers('session-1', 'task-1');

    expect(mocks.getMcpServersForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        forUserId: 'task-creator',
      }),
      { toolFiltering: 'intercept' }
    );
  });
});
