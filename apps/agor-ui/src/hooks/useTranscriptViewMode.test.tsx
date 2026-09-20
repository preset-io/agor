import type { AgorClient, User } from '@agor-live/client';
import { COMPACT_TRANSCRIPT_LAUNCH_AT } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptViewMode } from './useTranscriptViewMode';

const userById = vi.hoisted(() => new Map<string, User>());
vi.mock('../store/agorStore', () => ({
  useAgorStore: (selector: (state: { userById: Map<string, User> }) => unknown) =>
    selector({ userById }),
}));

const showError = vi.hoisted(() => vi.fn());
vi.mock('../utils/message', () => ({ useThemedMessage: () => ({ showError }) }));

const seedUser = (created_at: Date, preferences?: User['preferences']) => {
  userById.set('user-1', {
    user_id: 'user-1',
    created_at,
    preferences,
  } as unknown as User);
};

function clientWithPatch(patch: ReturnType<typeof vi.fn>) {
  return { service: () => ({ patch }) } as unknown as AgorClient;
}

beforeEach(() => {
  userById.clear();
  showError.mockClear();
});

describe('useTranscriptViewMode', () => {
  it('keeps accounts created before launch on detailed and newer ones on compact', () => {
    seedUser(new Date(COMPACT_TRANSCRIPT_LAUNCH_AT - 1));
    const existing = renderHook(() => useTranscriptViewMode(clientWithPatch(vi.fn()), 'user-1'));
    expect(existing.result.current.mode).toBe('detailed');

    seedUser(new Date(COMPACT_TRANSCRIPT_LAUNCH_AT + 1));
    const fresh = renderHook(() => useTranscriptViewMode(clientWithPatch(vi.fn()), 'user-1'));
    expect(fresh.result.current.mode).toBe('compact');
  });

  it('honors an explicit choice over the account-age default', () => {
    seedUser(new Date(COMPACT_TRANSCRIPT_LAUNCH_AT - 1), { transcriptViewMode: 'compact' });
    const { result } = renderHook(() => useTranscriptViewMode(clientWithPatch(vi.fn()), 'user-1'));
    expect(result.current.mode).toBe('compact');
  });

  it('persists the choice without dropping the user other preferences', async () => {
    seedUser(new Date(COMPACT_TRANSCRIPT_LAUNCH_AT - 1), { mainBoardId: 'board-1' });
    const patch = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() => useTranscriptViewMode(clientWithPatch(patch), 'user-1'));

    await act(async () => result.current.setMode('compact'));

    expect(patch).toHaveBeenCalledWith('user-1', {
      preferences: { mainBoardId: 'board-1', transcriptViewMode: 'compact' },
    });
  });

  it('reports the failure instead of silently losing the choice', async () => {
    seedUser(new Date(COMPACT_TRANSCRIPT_LAUNCH_AT - 1));
    const patch = vi.fn().mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useTranscriptViewMode(clientWithPatch(patch), 'user-1'));

    await act(async () => result.current.setMode('compact'));

    await waitFor(() => expect(showError).toHaveBeenCalledWith(expect.stringContaining('offline')));
  });

  it('hides the control and stays on detailed when the user record is unavailable', () => {
    const { result } = renderHook(() => useTranscriptViewMode(clientWithPatch(vi.fn()), 'user-1'));
    expect(result.current.mode).toBe('detailed');
    expect(result.current.canChange).toBe(false);
  });
});
