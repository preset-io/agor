import type { AgorClient } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useOAuthBrowserEventAttempt } from './useOAuthBrowserEventAttempt';

type BrowserListener = (event: Record<string, unknown>) => void;

function createSocketClient() {
  const listeners = new Set<BrowserListener>();
  const io = {
    on: vi.fn((_event: string, listener: BrowserListener) => listeners.add(listener)),
    off: vi.fn((_event: string, listener: BrowserListener) => listeners.delete(listener)),
  };
  return {
    client: { io } as unknown as AgorClient,
    io,
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function useHarness(client: AgorClient, userId: string, authGeneration: number, allowed = true) {
  const guard = useAuthorityOperationGuard(allowed ? [client, userId, authGeneration] : null);
  return useOAuthBrowserEventAttempt({
    client,
    currentUserId: userId,
    authGeneration,
    authorityGuard: guard,
  });
}

describe('useOAuthBrowserEventAttempt', () => {
  const open = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('open', open);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('opens only the exact caller/generation/operation once and removes the listener first', () => {
    const socket = createSocketClient();
    const { result } = renderHook(() => useHarness(socket.client, 'admin-a', 7));
    const attempt = result.current.begin();
    expect(attempt).not.toBeNull();
    expect(socket.listenerCount()).toBe(1);

    act(() => {
      socket.emit({
        authUrl: 'https://provider.example/unrelated',
        attempt_id: 'attempt-wrong-operation',
        operation_id: 'not-this-operation',
        auth_generation: 7,
        caller_user_id: 'admin-a',
      });
      socket.emit({
        authUrl: 'https://provider.example/wrong-user',
        attempt_id: 'attempt-wrong-user',
        operation_id: attempt?.request.operation_id,
        auth_generation: 7,
        caller_user_id: 'admin-b',
      });
      socket.emit({
        authUrl: 'https://provider.example/wrong-generation',
        attempt_id: 'attempt-wrong-generation',
        operation_id: attempt?.request.operation_id,
        auth_generation: 8,
        caller_user_id: 'admin-a',
      });
    });
    expect(open).not.toHaveBeenCalled();
    expect(socket.listenerCount()).toBe(1);

    const matching = {
      authUrl: 'https://provider.example/authorize',
      attempt_id: 'attempt-a',
      operation_id: attempt?.request.operation_id,
      auth_generation: 7,
      caller_user_id: 'admin-a',
    };
    act(() => socket.emit(matching));
    expect(socket.listenerCount()).toBe(0);
    expect(socket.io.off).toHaveBeenCalledBefore(open);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      'https://provider.example/authorize',
      '_blank',
      'noopener,noreferrer'
    );

    act(() => socket.emit(matching));
    expect(open).toHaveBeenCalledOnce();
  });

  it('discards a delayed A event after an in-place same-role A to B replacement', () => {
    const socket = createSocketClient();
    const rendered = renderHook(
      ({ userId, generation }) => useHarness(socket.client, userId, generation),
      { initialProps: { userId: 'admin-a', generation: 12 } }
    );
    const attemptA = rendered.result.current.begin();
    expect(socket.listenerCount()).toBe(1);

    rendered.rerender({ userId: 'admin-b', generation: 13 });
    expect(socket.listenerCount()).toBe(0);

    act(() => {
      socket.emit({
        authUrl: 'https://provider.example/a-authorize',
        attempt_id: 'attempt-a',
        operation_id: attemptA?.request.operation_id,
        auth_generation: 12,
        caller_user_id: 'admin-a',
      });
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('removes the listener in layout when the same identity loses authority', () => {
    const socket = createSocketClient();
    const rendered = renderHook(
      ({ allowed }) => useHarness(socket.client, 'admin-a', 12, allowed),
      { initialProps: { allowed: true } }
    );
    const attempt = rendered.result.current.begin();
    expect(socket.listenerCount()).toBe(1);

    rendered.rerender({ allowed: false });
    expect(socket.listenerCount()).toBe(0);
    act(() => {
      socket.emit({
        authUrl: 'https://provider.example/a-authorize',
        attempt_id: 'attempt-a',
        operation_id: attempt?.request.operation_id,
        auth_generation: 12,
        caller_user_id: 'admin-a',
      });
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('cleans up an abandoned request and all outstanding requests on unmount', () => {
    const socket = createSocketClient();
    const rendered = renderHook(() => useHarness(socket.client, 'admin-a', 2));
    const first = rendered.result.current.begin();
    rendered.result.current.begin();
    expect(socket.listenerCount()).toBe(2);

    first?.cleanup();
    first?.cleanup();
    expect(socket.listenerCount()).toBe(1);

    rendered.unmount();
    expect(socket.listenerCount()).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });
});
