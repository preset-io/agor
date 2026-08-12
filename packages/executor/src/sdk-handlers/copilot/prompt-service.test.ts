import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionID } from '../../types.js';

const mocks = vi.hoisted(() => ({
  getMcpServersForSession: vi.fn(),
}));

vi.mock('@agor/core/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/mcp')>()),
  getMcpServersForSession: mocks.getMcpServersForSession,
}));

import { CopilotPromptService } from './prompt-service.js';

const sessionId = '01980d95-43cd-7a46-a0af-6dbf2aaa121e' as SessionID;

function createService(): CopilotPromptService {
  return new CopilotPromptService({} as never, {} as never);
}

describe('CopilotPromptService', () => {
  it('does not launch SDK work after cancellation', async () => {
    const service = createService();
    const abortController = new AbortController();
    abortController.abort();

    const result = await service
      .promptSessionStreaming(sessionId, 'prompt', undefined, undefined, abortController)
      .next();

    expect(result.value).toEqual({ type: 'stopped', sessionId: '' });
    expect(result.done).toBe(false);
  });

  it('confirms cancellation only after the SDK client stops', async () => {
    const service = createService();
    const stop = vi.fn().mockResolvedValue(undefined);
    Reflect.set(service, 'client', { stop });

    await expect(service.stopTask(sessionId)).resolves.toEqual({ success: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(Reflect.get(service, 'client')).toBeNull();
  });

  it('keeps cancellation unverified when the SDK client cannot stop', async () => {
    const service = createService();
    Reflect.set(service, 'client', {
      stop: vi.fn().mockRejectedValue(new Error('stop failed')),
    });

    await expect(service.stopTask(sessionId)).resolves.toEqual({
      success: false,
      reason: 'stop failed',
    });
  });
});

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
        sessionOwnerId: 'session-owner',
      }),
      { toolFiltering: 'none' }
    );
  });
});
