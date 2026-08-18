import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMcpMemberPolicy } from './useMcpMemberPolicy';

describe('useMcpMemberPolicy', () => {
  it('treats a save response without a capability as withheld', async () => {
    const find = vi.fn().mockResolvedValue({
      policy: 'use_existing_only',
      can_configure: true,
    });
    const patch = vi.fn().mockResolvedValue({ policy: 'allow_crud' });
    const client = {
      service: () => ({ find, patch }),
    } as unknown as AgorClient;

    const { result } = renderHook(() => useMcpMemberPolicy(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.save('allow_crud'));

    expect(patch).toHaveBeenCalledWith(null, { policy: 'allow_crud' });
    expect(result.current).toMatchObject({
      policy: 'allow_crud',
      canConfigure: false,
      saving: false,
      error: null,
    });
  });
});
