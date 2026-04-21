import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCodexDeviceAuth } from './useCodexDeviceAuth';

describe('useCodexDeviceAuth', () => {
  it('starts the device auth flow through the daemon service', async () => {
    const create = vi.fn().mockResolvedValue({
      flowId: 'flow-1',
      status: 'pending',
      verificationUri: 'https://chatgpt.com/device',
      userCode: 'ABCD-EFGHI',
    });
    const get = vi.fn();
    const remove = vi.fn();
    const client = {
      service: vi.fn().mockReturnValue({ create, get, remove }),
    } as any;

    const { result } = renderHook(() => useCodexDeviceAuth(client));

    await act(async () => {
      await result.current.start();
    });

    expect(client.service).toHaveBeenCalledWith('codex-device-auth');
    expect(create).toHaveBeenCalledWith({});
    expect(result.current.flow?.flowId).toBe('flow-1');
  });
});
