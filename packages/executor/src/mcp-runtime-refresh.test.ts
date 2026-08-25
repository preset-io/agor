import type { MCPRuntimeRefreshRequest, MCPRuntimeReprojection, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { registerMCPRuntimeRefreshHandler, requestMCPRuntimeRefresh } from './mcp-runtime-refresh';

describe('task-scoped MCP runtime refresh registry', () => {
  it('coalesces only in-flight delivery and permits a durable reconnect retry', async () => {
    const taskId = '01999999-0000-7000-8000-000000000001' as TaskID;
    const response = { request_id: 'same' } as MCPRuntimeReprojection;
    let release!: (value: MCPRuntimeReprojection) => void;
    const handler = vi.fn(
      () => new Promise<MCPRuntimeReprojection>((resolve) => (release = resolve))
    );
    const unregister = registerMCPRuntimeRefreshHandler(taskId, handler);

    const first = requestMCPRuntimeRefresh(taskId, {
      requestId: 'same',
      reason: 'authority_changed',
      expectedGeneration: 1,
    });
    const duplicate = requestMCPRuntimeRefresh(taskId, {
      requestId: 'same',
      reason: 'authority_changed',
      expectedGeneration: 1,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    release(response);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([response, response]);
    const retry = requestMCPRuntimeRefresh(taskId, {
      requestId: 'same',
      reason: 'user_reconnect',
      expectedGeneration: 1,
    });
    expect(handler).toHaveBeenCalledTimes(2);
    release(response);
    await expect(retry).resolves.toBe(response);

    unregister();
    await expect(
      requestMCPRuntimeRefresh(taskId, { reason: 'user_reconnect', expectedGeneration: 1 })
    ).rejects.toThrow('Provider MCP refresh is not available');
  });

  it('does not reuse a completed response across recovery generations', async () => {
    const taskId = '01999999-0000-7000-8000-000000000002' as TaskID;
    const handler = vi.fn(async (request: MCPRuntimeRefreshRequest) => {
      return {
        request_id: request.request_id,
        states: [{ generation: request.expected_generation }],
      } as unknown as MCPRuntimeReprojection;
    });
    const unregister = registerMCPRuntimeRefreshHandler(taskId, handler);

    await requestMCPRuntimeRefresh(taskId, {
      requestId: 'same-id',
      reason: 'authority_changed',
      expectedGeneration: 1,
    });
    await requestMCPRuntimeRefresh(taskId, {
      requestId: 'same-id',
      reason: 'authority_changed',
      expectedGeneration: 2,
    });

    expect(handler).toHaveBeenCalledTimes(2);
    unregister();
  });
});
