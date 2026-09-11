import type { Branch } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionTeammates } from './useSessionTeammates';

const teammate = (branchId: string, options: { archived?: boolean; teammate?: boolean } = {}) =>
  ({
    branch_id: branchId,
    name: branchId,
    archived: options.archived,
    custom_context:
      options.teammate === false
        ? undefined
        : { teammate: { kind: 'teammate', displayName: branchId } },
  }) as unknown as Branch;

function clientWith(preferred: Branch | null, candidates: Branch[]) {
  const getPrimaryTeammate = vi.fn(async () => preferred);
  const getPrimaryTeammateCandidates = vi.fn(async () => candidates);
  return {
    client: {
      service: vi.fn(() => ({ getPrimaryTeammate, getPrimaryTeammateCandidates })),
    } as unknown as AgorClient,
    getPrimaryTeammate,
    getPrimaryTeammateCandidates,
  };
}

describe('useSessionTeammates', () => {
  it('loads only active teammate candidates and preserves an eligible preference', async () => {
    const preferred = teammate('preferred');
    const archived = teammate('archived', { archived: true });
    const ordinary = teammate('ordinary', { teammate: false });
    const api = clientWith(preferred, [archived, ordinary, preferred]);

    const { result } = renderHook(() => useSessionTeammates(api.client, true, 'user-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.teammates).toEqual([preferred]);
    expect(result.current.preferredTeammateId).toBe(preferred.branch_id);
    expect(api.getPrimaryTeammateCandidates).toHaveBeenCalledOnce();
  });

  it('does not query before explicit session setup and falls back to the first eligible teammate', async () => {
    const unavailablePreference = teammate('archived', { archived: true });
    const first = teammate('first');
    const api = clientWith(unavailablePreference, [unavailablePreference, first]);

    const { result, rerender } = renderHook(
      ({ enabled }) => useSessionTeammates(api.client, enabled, 'user-1'),
      { initialProps: { enabled: false } }
    );
    expect(api.getPrimaryTeammateCandidates).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.preferredTeammateId).toBe(first.branch_id);
  });
});

it('ignores a late old-caller list and fails closed when the new caller cannot load candidates', async () => {
  let resolve!: (value: Branch[]) => void;
  const old = clientWith(null, []);
  old.getPrimaryTeammateCandidates.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const next = clientWith(null, []);
  next.getPrimaryTeammateCandidates.mockRejectedValue(new Error('Not authorized'));
  const { result, rerender } = renderHook(
    ({ client, identity }) => useSessionTeammates(client, true, identity),
    { initialProps: { client: old.client, identity: 'alice' } }
  );
  rerender({ client: next.client, identity: 'bob' });
  await act(async () => {
    resolve([teammate('alice-private')]);
  });
  await waitFor(() => expect(result.current.error).toBe('Not authorized'));
  expect(result.current.teammates).toEqual([]);
  expect(result.current.preferredTeammateId).toBeNull();
});
