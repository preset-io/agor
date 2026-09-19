import type { AgorClient } from '@agor-live/client';
import { PermissionScope } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePermissionDecision } from './usePermissionDecision';

function makeClient(create = vi.fn(async () => ({}))) {
  const service = vi.fn(() => ({ create }));
  return { client: { service } as unknown as AgorClient, service, create };
}

describe('usePermissionDecision', () => {
  it('posts the decision to the session endpoint and remembers non-once scopes', async () => {
    const { client, service, create } = makeClient();
    const { result } = renderHook(() => usePermissionDecision(client));

    await result.current('session-1', 'request-1', 'task-1', true, PermissionScope.ONCE);
    expect(service).toHaveBeenCalledWith('sessions/session-1/permission-decision');
    expect(create).toHaveBeenLastCalledWith({
      requestId: 'request-1',
      taskId: 'task-1',
      allow: true,
      reason: 'Approved by user',
      remember: false,
      scope: PermissionScope.ONCE,
    });

    await result.current('session-1', 'request-2', 'task-1', false, PermissionScope.PROJECT);
    expect(create).toHaveBeenLastCalledWith({
      requestId: 'request-2',
      taskId: 'task-1',
      allow: false,
      reason: 'Denied by user',
      remember: true,
      scope: PermissionScope.PROJECT,
    });
  });

  it('is a no-op without a client and swallows transport errors', async () => {
    const { result: offline } = renderHook(() => usePermissionDecision(null));
    await expect(
      offline.current('s', 'r', 't', true, PermissionScope.ONCE)
    ).resolves.toBeUndefined();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeClient(vi.fn(async () => Promise.reject(new Error('offline'))));
    const { result } = renderHook(() => usePermissionDecision(client));
    await expect(
      result.current('s', 'r', 't', true, PermissionScope.ONCE)
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
