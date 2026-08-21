import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMCPServerOAuthStart } from './useMCPServerOAuthStart';

const oauthAttempt = vi.hoisted(() => ({
  refetch: vi.fn(),
  wait: vi.fn(),
}));

vi.mock('@/utils/mcpOAuthAttempt', () => ({
  oauthAttemptFailureMessage: vi.fn(),
  refetchMCPOAuthDurableState: oauthAttempt.refetch,
  waitForMCPOAuthAttempt: oauthAttempt.wait,
}));

const showError = vi.fn();
const showInfo = vi.fn();
const showSuccess = vi.fn();

function oauthClient(startOAuth: ReturnType<typeof vi.fn>) {
  return {
    service: vi.fn((path: string) => {
      if (path === 'mcp-servers/oauth-start') return { create: startOAuth };
      throw new Error(`Unexpected service ${path}`);
    }),
  } as unknown as AgorClient;
}

describe('useMCPServerOAuthStart', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prepares persisted settings first, sends only the server ID, and rejects double starts', async () => {
    let resolvePreparation: ((serverId: string) => void) | undefined;
    const onPrepareOAuthStart = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvePreparation = resolve;
        })
    );
    const startOAuth = vi.fn().mockResolvedValue({
      success: false,
      error: 'Not an OAuth challenge',
    });
    const client = oauthClient(startOAuth);
    const { result } = renderHook(() =>
      useMCPServerOAuthStart({
        client,
        authorityKey: 'user-a:admin:1',
        onPrepareOAuthStart,
        showError,
        showInfo,
        showSuccess,
      })
    );

    let firstStart: Promise<void> | undefined;
    await act(async () => {
      firstStart = result.current.handleStartOAuthFlow();
      void result.current.handleStartOAuthFlow();
      resolvePreparation?.('server-1');
      await firstStart;
    });

    expect(onPrepareOAuthStart).toHaveBeenCalledOnce();
    expect(startOAuth).toHaveBeenCalledOnce();
    expect(startOAuth).toHaveBeenCalledWith({ mcp_server_id: 'server-1' });
  });

  it('does not start OAuth after unmount while preparation is pending', async () => {
    let resolvePreparation: ((serverId: string) => void) | undefined;
    const onPrepareOAuthStart = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvePreparation = resolve;
        })
    );
    const startOAuth = vi.fn();
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result, unmount } = renderHook(() =>
      useMCPServerOAuthStart({
        client: oauthClient(startOAuth),
        authorityKey: 'user-a:admin:1',
        onPrepareOAuthStart,
        showError,
        showInfo,
        showSuccess,
      })
    );

    let startPromise: Promise<void> | undefined;
    await act(async () => {
      startPromise = result.current.handleStartOAuthFlow();
      await Promise.resolve();
    });

    unmount();
    await act(async () => {
      resolvePreparation?.('server-1');
      await startPromise;
    });

    expect(startOAuth).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it('does not open the authorization URL after unmount while oauth-start is pending', async () => {
    let resolveStart:
      | ((result: { success: true; authorizationUrl: string; attempt_id: string }) => void)
      | undefined;
    const startOAuth = vi.fn(
      () =>
        new Promise<{ success: true; authorizationUrl: string; attempt_id: string }>((resolve) => {
          resolveStart = resolve;
        })
    );
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result, unmount } = renderHook(() =>
      useMCPServerOAuthStart({
        client: oauthClient(startOAuth),
        authorityKey: 'user-a:admin:1',
        onPrepareOAuthStart: vi.fn().mockResolvedValue('server-1'),
        showError,
        showInfo,
        showSuccess,
      })
    );

    let startPromise: Promise<void> | undefined;
    await act(async () => {
      startPromise = result.current.handleStartOAuthFlow();
    });
    await waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());

    unmount();
    await act(async () => {
      resolveStart?.({
        success: true,
        authorizationUrl: 'https://provider.example/authorize',
        attempt_id: 'attempt-1',
      });
      await startPromise;
    });

    expect(windowOpen).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it('classifies DCR recovery and accepts the authoritative redirect URL', async () => {
    const startOAuth = vi.fn().mockResolvedValue({
      success: false,
      error: 'Dynamic Client Registration failed',
      diagnostic: { stage: 'dcr_registration', http_status: 404 },
      redirect_uri: 'https://agor.example.com/mcp-servers/oauth-callback',
    });
    const { result } = renderHook(() =>
      useMCPServerOAuthStart({
        client: oauthClient(startOAuth),
        authorityKey: 'user-a:admin:1',
        onPrepareOAuthStart: vi.fn().mockResolvedValue('server-1'),
        showError,
        showInfo,
        showSuccess,
      })
    );

    await act(async () => result.current.handleStartOAuthFlow());

    expect(result.current.oauthFailure).toMatchObject({
      diagnostic: { stage: 'dcr_registration', http_status: 404 },
      redirectUri: 'https://agor.example.com/mcp-servers/oauth-callback',
    });
  });

  it('keeps generic OAuth failures out of manual-client recovery', async () => {
    const startOAuth = vi.fn().mockResolvedValue({
      success: false,
      error: 'No public base URL configured',
    });
    const { result } = renderHook(() =>
      useMCPServerOAuthStart({
        client: oauthClient(startOAuth),
        authorityKey: 'user-a:admin:1',
        onPrepareOAuthStart: vi.fn().mockResolvedValue('server-1'),
        showError,
        showInfo,
        showSuccess,
      })
    );

    await act(async () => result.current.handleStartOAuthFlow());
    expect(result.current.oauthFailure).toEqual({
      message: 'No public base URL configured',
      diagnostic: undefined,
      redirectUri: undefined,
    });
  });

  it.each([
    {
      transition: 'demotion',
      nextAuthorityKey: 'user-a:viewer:2',
      nextAllowed: false,
    },
    { transition: 'disconnect', nextAuthorityKey: null, nextAllowed: false },
    {
      transition: 'identity replacement',
      nextAuthorityKey: 'user-b:admin:2',
      nextAllowed: true,
    },
    {
      transition: 'policy downgrade',
      nextAuthorityKey: 'user-a:admin:1',
      nextAllowed: false,
    },
  ])(
    'guards the durable completion apply across $transition during its reads',
    async ({ nextAuthorityKey, nextAllowed }) => {
      let releaseRefetch!: () => void;
      const refetchPending = new Promise<void>((resolve) => {
        releaseRefetch = resolve;
      });
      oauthAttempt.wait.mockResolvedValue({
        status: 'succeeded',
        mcp_server_id: 'server-1',
      });
      oauthAttempt.refetch.mockImplementation(async () => refetchPending);
      const startOAuth = vi.fn().mockResolvedValue({
        success: true,
        authorizationUrl: 'https://provider.example/authorize',
        attempt_id: 'attempt-1',
      });
      const client = oauthClient(startOAuth);
      const onOAuthAttemptStarted = vi.fn();
      const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
      const { result, rerender } = renderHook(
        ({ authorityKey, startAllowed }: { authorityKey: string | null; startAllowed: boolean }) =>
          useMCPServerOAuthStart({
            client,
            authorityKey,
            onPrepareOAuthStart: vi.fn().mockResolvedValue('server-1'),
            onOAuthAttemptStarted,
            showError,
            showInfo,
            showSuccess,
            startAllowed,
          }),
        { initialProps: { authorityKey: 'user-a:admin:1', startAllowed: true } }
      );

      await act(async () => result.current.handleStartOAuthFlow());
      expect(onOAuthAttemptStarted).toHaveBeenCalledOnce();
      expect(onOAuthAttemptStarted).toHaveBeenCalledWith('attempt-1', 'server-1');
      await waitFor(() => expect(oauthAttempt.refetch).toHaveBeenCalledOnce());
      const shouldApply = oauthAttempt.refetch.mock.calls[0]?.[2] as () => boolean;
      expect(shouldApply()).toBe(true);

      rerender({ authorityKey: nextAuthorityKey, startAllowed: nextAllowed });
      expect(shouldApply()).toBe(false);

      await act(async () => {
        releaseRefetch();
        await refetchPending;
      });
      expect(showSuccess).not.toHaveBeenCalled();
      windowOpen.mockRestore();
    }
  );

  it('guards the durable completion apply when the OAuth owner unmounts during its reads', async () => {
    let releaseRefetch!: () => void;
    const refetchPending = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    oauthAttempt.wait.mockResolvedValue({ status: 'succeeded', mcp_server_id: 'server-1' });
    oauthAttempt.refetch.mockImplementation(async () => refetchPending);
    const startOAuth = vi.fn().mockResolvedValue({
      success: true,
      authorizationUrl: 'https://provider.example/authorize',
      attempt_id: 'attempt-1',
    });
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result, unmount } = renderHook(() =>
      useMCPServerOAuthStart({
        client: oauthClient(startOAuth),
        authorityKey: 'user-a:admin:1',
        onPrepareOAuthStart: vi.fn().mockResolvedValue('server-1'),
        showError,
        showInfo,
        showSuccess,
      })
    );

    await act(async () => result.current.handleStartOAuthFlow());
    await waitFor(() => expect(oauthAttempt.refetch).toHaveBeenCalledOnce());
    const shouldApply = oauthAttempt.refetch.mock.calls[0]?.[2] as () => boolean;
    unmount();
    expect(shouldApply()).toBe(false);

    releaseRefetch();
    await refetchPending;
    expect(showSuccess).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });
});
