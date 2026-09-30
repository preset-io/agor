import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionAccess } from './useSessionAccess';

const session = { can: 'session', is_owner: false, source: 'others' };

describe('useSessionAccess', () => {
  it('shows failures as pending again once a grown id set re-reads them', async () => {
    const waiting = new Map<string, (value: unknown) => void>();
    const find = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(
        ({ route }: { route: { id: string } }) =>
          new Promise((resolve) => waiting.set(route.id, resolve))
      );
    const client = { service: () => ({ find }) } as unknown as AgorClient;
    const { result, rerender } = renderHook(({ ids }) => useSessionAccess(client, 'me', ids), {
      initialProps: { ids: ['a'] },
    });
    await waitFor(() => expect(result.current.failed).toBe(1));
    expect(result.current.failedIds.has('a')).toBe(true);

    rerender({ ids: ['a', 'b'] });
    expect(result.current.failed).toBe(0);
    expect(result.current.failedIds.size).toBe(0);

    await waitFor(() => expect(waiting.size).toBe(2));
    await act(async () => {
      for (const resolve of waiting.values()) resolve(session);
    });
    await waitFor(() => expect(result.current.access).toEqual({ a: true, b: true }));
    expect(result.current.failed).toBe(0);
  });
});
