import type { AgorClient } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useOAuthBrowserEventAttempt } from './useOAuthBrowserEventAttempt';

type BrowserListener = (event: Record<string, unknown> | null | undefined) => void;

function createSocketClient() {
  const listeners = new Set<BrowserListener>();
  let nextToken = 0;
  const reserve = vi.fn(async () => ({
    reservation_token: `server-reservation-${String(++nextToken).padStart(16, '0')}`,
    expires_at: Date.now() + 60_000,
  }));
  const io = {
    on: vi.fn((_event: string, listener: BrowserListener) => listeners.add(listener)),
    off: vi.fn((_event: string, listener: BrowserListener) => listeners.delete(listener)),
  };
  return {
    client: {
      io,
      service: (path: string) => {
        if (path !== 'mcp-servers/oauth-browser-reservations') throw new Error(path);
        return { create: reserve };
      },
    } as unknown as AgorClient,
    io,
    reserve,
    emit: (event: Record<string, unknown> | null | undefined) => {
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

  beforeEach(() => vi.stubGlobal('open', open));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reserves server correlation and opens only the exact token/caller once', async () => {
    const socket = createSocketClient();
    const { result } = renderHook(() => useHarness(socket.client, 'admin-a', 7));
    const attempt = await act(() =>
      result.current.begin({ operation: 'discover', mcpServerId: 'saved-server' })
    );
    expect(socket.reserve).toHaveBeenCalledWith({
      operation: 'discover',
      mcp_server_id: 'saved-server',
    });
    expect(attempt).not.toBeNull();
    expect(socket.listenerCount()).toBe(1);

    act(() => {
      socket.emit(null);
      socket.emit(undefined);
      socket.emit({
        authUrl: 'https://provider.example/unrelated',
        attempt_id: 'attempt-wrong-operation',
        reservation_token: 'server-reservation-unrelated-0000',
        caller_user_id: 'admin-a',
      });
      socket.emit({
        authUrl: 'https://provider.example/wrong-user',
        attempt_id: 'attempt-wrong-user',
        reservation_token: attempt?.request.reservation_token,
        caller_user_id: 'admin-b',
      });
      socket.emit({ reservation_token: attempt?.request.reservation_token });
    });
    expect(open).not.toHaveBeenCalled();
    expect(socket.listenerCount()).toBe(1);

    const matching = {
      authUrl: 'https://provider.example/authorize',
      attempt_id: 'attempt-a',
      reservation_token: attempt?.request.reservation_token,
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

  it('drops a reservation that resolves after A is replaced by same-role B', async () => {
    const socket = createSocketClient();
    let release!: (value: { reservation_token: string; expires_at: number }) => void;
    socket.reserve.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const rendered = renderHook(
      ({ userId, generation }) => useHarness(socket.client, userId, generation),
      { initialProps: { userId: 'admin-a', generation: 12 } }
    );
    const pending = rendered.result.current.begin({ operation: 'discover' });
    rendered.rerender({ userId: 'admin-b', generation: 13 });
    release({ reservation_token: 'server-reservation-delayed-000000', expires_at: Date.now() });
    await expect(pending).resolves.toBeNull();
    expect(socket.listenerCount()).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('tears down delayed A events on identity, generation, and authority changes', async () => {
    const socket = createSocketClient();
    const rendered = renderHook(
      ({ userId, generation, allowed }) => useHarness(socket.client, userId, generation, allowed),
      { initialProps: { userId: 'admin-a', generation: 12, allowed: true } }
    );
    const attemptA = await rendered.result.current.begin({ operation: 'discover' });
    expect(socket.listenerCount()).toBe(1);
    rendered.rerender({ userId: 'admin-a', generation: 13, allowed: true });
    expect(socket.listenerCount()).toBe(0);
    act(() =>
      socket.emit({
        authUrl: 'https://provider.example/a-authorize',
        attempt_id: 'attempt-a',
        reservation_token: attemptA?.request.reservation_token,
        caller_user_id: 'admin-a',
      })
    );
    expect(open).not.toHaveBeenCalled();

    const attemptB = await rendered.result.current.begin({ operation: 'discover' });
    rendered.rerender({ userId: 'admin-b', generation: 14, allowed: true });
    expect(socket.listenerCount()).toBe(0);
    expect(attemptB).not.toBeNull();
    rendered.rerender({ userId: 'admin-b', generation: 14, allowed: false });
    expect(socket.listenerCount()).toBe(0);
  });

  it('cleans abandoned and outstanding reservations exactly once', async () => {
    const socket = createSocketClient();
    const rendered = renderHook(() => useHarness(socket.client, 'admin-a', 2));
    const first = await rendered.result.current.begin({ operation: 'discover' });
    await rendered.result.current.begin({ operation: 'discover' });
    expect(socket.listenerCount()).toBe(2);
    first?.cleanup();
    first?.cleanup();
    expect(socket.listenerCount()).toBe(1);
    rendered.unmount();
    expect(socket.listenerCount()).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('expires and removes a reserved listener at the daemon deadline', async () => {
    vi.useFakeTimers();
    const socket = createSocketClient();
    socket.reserve.mockResolvedValueOnce({
      reservation_token: 'server-reservation-expiring-00000',
      expires_at: Date.now() + 1_000,
    });
    const rendered = renderHook(() => useHarness(socket.client, 'admin-a', 2));
    const attempt = await rendered.result.current.begin({ operation: 'discover' });
    expect(attempt).not.toBeNull();
    expect(socket.listenerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(1_000));
    expect(socket.listenerCount()).toBe(0);
    act(() =>
      socket.emit({
        authUrl: 'https://provider.example/too-late',
        attempt_id: 'attempt-expired',
        reservation_token: attempt?.request.reservation_token,
        caller_user_id: 'admin-a',
      })
    );
    expect(open).not.toHaveBeenCalled();
  });
});
