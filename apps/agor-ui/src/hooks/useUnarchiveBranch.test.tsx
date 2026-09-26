import type { AgorClient } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnarchiveBranch } from './useUnarchiveBranch';

const messages = vi.hoisted(() => ({
  showLoading: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('../utils/message', () => ({ useThemedMessage: () => messages }));

function fixture() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const acknowledgement = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const create = vi.fn(() => acknowledgement);
  const client = { service: vi.fn(() => ({ create })) } as unknown as AgorClient;
  const hook = renderHook(() => useUnarchiveBranch(client));
  let wait!: Promise<void>;
  act(() => {
    wait = hook.result.current('branch', { boardId: 'board' });
  });
  // Attach rejection handling immediately, like the Settings action does.
  const outcome = wait.then(
    () => 'accepted',
    () => 'not-confirmed'
  );
  return { ...hook, create, client, resolve, reject, wait, outcome };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('unarchive acknowledgement', () => {
  it('bounds lost acknowledgements, never replays, and never reports ready', async () => {
    const f = fixture();
    expect(messages.showLoading).toHaveBeenCalledWith('Unarchiving branch...', {
      key: 'unarchive:branch',
    });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(await f.outcome).toBe('not-confirmed');
    expect(messages.showWarning).toHaveBeenCalledWith(
      expect.stringMatching(/outcome unknown.*Refresh the page/),
      { key: 'unarchive:branch', duration: 10 }
    );
    expect(messages.showError).not.toHaveBeenCalled();
    expect(messages.showSuccess).not.toHaveBeenCalled();
    expect(f.result.current('branch')).toBe(f.wait);
    expect(f.create).toHaveBeenCalledExactlyOnceWith({ boardId: 'board' });
    f.unmount();
    expect(messages.destroy).toHaveBeenCalledWith('unarchive:branch');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('handles success (late=%s) as acceptance, not readiness', async (late) => {
    const f = fixture();
    if (late) await act(() => vi.advanceTimersByTimeAsync(30_000));
    // Neither active=true nor this response is a readiness claim in the UI.
    await act(async () => f.resolve({ archived: false, filesystem_status: 'creating' }));
    expect(await f.outcome).toBe(late ? 'not-confirmed' : 'accepted');
    expect(messages.showSuccess).toHaveBeenCalledWith(
      expect.stringContaining('accepted; wait for filesystem recovery'),
      { key: 'unarchive:branch' }
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    'handles server rejection (late=%s) without an unhandled promise',
    async (late) => {
      const f = fixture();
      if (late) await act(() => vi.advanceTimersByTimeAsync(30_000));
      await act(async () => f.reject(new Error('Recovery blocked by unfinished tasks')));
      expect(await f.outcome).toBe('not-confirmed');
      expect(messages.showError).toHaveBeenCalledWith(
        expect.stringContaining('Recovery blocked by unfinished tasks'),
        { key: 'unarchive:branch' }
      );
      expect(messages.showSuccess).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['Socket connection timeout', 'socket has been disconnected'])(
    'classifies transport failure (%s) as unknown rather than mutation failure',
    async (message) => {
      const f = fixture();
      await act(async () => f.reject(new Error(message)));
      expect(await f.outcome).toBe('not-confirmed');
      expect(messages.showWarning).toHaveBeenCalledWith(
        expect.stringContaining('outcome unknown'),
        expect.anything()
      );
      expect(messages.showError).not.toHaveBeenCalled();
      expect(f.create).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['success', 'failure'] as const)(
    'ignores late %s after unmount and clears the toast',
    async (outcome) => {
      const f = fixture();
      f.unmount();
      expect(await f.outcome).toBe('not-confirmed');
      await act(async () => {
        if (outcome === 'success') f.resolve({ archived: false });
        else f.reject(new Error('Late rejection'));
      });
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(messages.showSuccess).not.toHaveBeenCalled();
      expect(messages.showError).not.toHaveBeenCalled();
      expect(messages.showWarning).not.toHaveBeenCalled();
      expect(messages.destroy).toHaveBeenCalledWith('unarchive:branch');
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
