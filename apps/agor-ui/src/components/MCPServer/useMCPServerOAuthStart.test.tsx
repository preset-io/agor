import type { AgorClient } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMCPServerOAuthStart } from './useMCPServerOAuthStart';

vi.mock('@/utils/mcpOAuthAttempt', () => ({
  oauthAttemptFailureMessage: vi.fn(),
  refetchMCPOAuthDurableState: vi.fn(),
  waitForMCPOAuthAttempt: vi.fn(),
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
});
