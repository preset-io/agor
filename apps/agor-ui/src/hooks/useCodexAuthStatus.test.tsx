import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCodexAuthStatus } from './useCodexAuthStatus';

describe('useCodexAuthStatus', () => {
  it('loads codex auth status for the current user', async () => {
    const get = vi.fn().mockResolvedValue({
      status: 'not_signed_in',
      label: 'Not signed in',
      description: 'Codex is not connected yet.',
      warnings: [],
      guidance: [],
      codexHome: '/tmp/.agor/codex/users/user-123',
      credentialStore: 'file',
      unixUserMode: 'simple',
      executionUnixUser: null,
    });
    const client = {
      service: vi.fn().mockReturnValue({ get }),
    } as any;

    const { result } = renderHook(() => useCodexAuthStatus(client));

    await waitFor(() => {
      expect(result.current.status?.status).toBe('not_signed_in');
    });

    expect(client.service).toHaveBeenCalledWith('codex-auth-status');
    expect(get).toHaveBeenCalledWith('current');
  });
});
