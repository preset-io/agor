import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerPill } from './MCPServerPill';

const permissionState = vi.hoisted(() => ({ isAdmin: false }));
const refreshAndRefetchMCPOAuthGrant = vi.hoisted(() => vi.fn());
const showError = vi.fn();
const showInfo = vi.fn();
const showSuccess = vi.fn();
const showWarning = vi.fn();

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => permissionState,
}));

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showError, showInfo, showSuccess, showWarning }),
}));

vi.mock('@/utils/mcpOAuthAttempt', () => ({
  refreshAndRefetchMCPOAuthGrant,
  refetchMCPOAuthDurableState: vi.fn(),
  waitForMCPOAuthAttempt: vi.fn(),
}));

describe('MCPServerPill OAuth recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.isAdmin = false;
  });

  it('uses the shared OAuth start path and exposes DCR diagnostics', async () => {
    const startOAuth = vi.fn().mockResolvedValue({
      success: false,
      error: 'Dynamic Client Registration failed',
      diagnostic: { stage: 'dcr_registration', http_status: 404 },
      redirect_uri: 'https://agor.example.com/mcp-servers/oauth-callback',
    });
    const client = {
      service: vi.fn(() => ({ create: startOAuth })),
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000004',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      transport: 'http',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;

    render(
      <MCPServerPill
        server={server}
        needsAuth
        client={client}
        authorityKey="user-a:member:1"
        actionAllowed
        actionBlockedReason="OAuth unavailable"
      />
    );

    const signIn = screen.getByRole('button', { name: 'Sign in to OAuth Server' });
    expect(signIn.tagName).toBe('BUTTON');
    act(() => signIn.focus());
    expect(signIn).toHaveFocus();
    fireEvent.click(signIn);

    await waitFor(() => expect(startOAuth).toHaveBeenCalledOnce());
    expect(startOAuth).toHaveBeenCalledWith({
      mcp_server_id: '01900000-0000-7000-8000-000000000004',
    });
    expect(await screen.findByText('OAuth setup needs attention')).toBeVisible();
    expect(screen.getByText(/HTTP 404/)).toBeVisible();
    expect(screen.getByText(/mcp-servers\/oauth-callback/)).toBeVisible();
  });

  it('names the admin edit action for the server it edits', () => {
    permissionState.isAdmin = true;
    const onEdit = vi.fn();
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000005',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      transport: 'http',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;

    render(
      <MCPServerPill
        server={server}
        needsAuth
        client={null}
        authorityKey={null}
        actionAllowed={false}
        actionBlockedReason="OAuth unavailable"
        onEdit={onEdit}
      />
    );

    const edit = screen.getByRole('button', { name: 'Edit OAuth Server MCP server' });
    expect(edit).toBeInTheDocument();
    fireEvent.click(edit);
    expect(onEdit).toHaveBeenCalledWith(server);
  });

  it('exposes authenticated OAuth refresh as a named native button', async () => {
    refreshAndRefetchMCPOAuthGrant.mockResolvedValue({ success: true });
    const client = {} as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000006',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      transport: 'http',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;

    render(
      <MCPServerPill
        server={server}
        needsAuth={false}
        client={client}
        authorityKey="user-a:member:1"
        actionAllowed
        actionBlockedReason="OAuth unavailable"
      />
    );

    const refresh = screen.getByRole('button', {
      name: 'Refresh OAuth credentials for OAuth Server',
    });
    expect(refresh.tagName).toBe('BUTTON');
    act(() => refresh.focus());
    expect(refresh).toHaveFocus();
    fireEvent.click(refresh);

    await waitFor(() =>
      expect(refreshAndRefetchMCPOAuthGrant).toHaveBeenCalledWith(
        client,
        '01900000-0000-7000-8000-000000000006',
        expect.any(Function)
      )
    );
  });

  it.each([
    { transition: 'demotion', authorityKey: null, actionAllowed: false },
    { transition: 'disconnect', authorityKey: null, actionAllowed: false },
    {
      transition: 'identity replacement',
      authorityKey: 'user-b:member:2',
      actionAllowed: true,
    },
  ])(
    'guards refresh durable application across $transition while reads are in flight',
    async ({ authorityKey, actionAllowed }) => {
      let releaseRefresh!: () => void;
      const refreshPending = new Promise<{ success: true; expires_at: number }>((resolve) => {
        releaseRefresh = () => resolve({ success: true, expires_at: 123 });
      });
      refreshAndRefetchMCPOAuthGrant.mockImplementation(async () => refreshPending);
      const client = {} as AgorClient;
      const server = {
        mcp_server_id: '01900000-0000-7000-8000-000000000007',
        name: 'oauth-server',
        display_name: 'OAuth Server',
        transport: 'http',
        scope: 'global',
        enabled: true,
        auth: { type: 'oauth' },
      } as MCPServer;
      const { rerender } = render(
        <MCPServerPill
          server={server}
          needsAuth={false}
          client={client}
          authorityKey="user-a:member:1"
          actionAllowed
          actionBlockedReason="OAuth unavailable"
        />
      );

      fireEvent.click(
        screen.getByRole('button', { name: 'Refresh OAuth credentials for OAuth Server' })
      );
      await waitFor(() => expect(refreshAndRefetchMCPOAuthGrant).toHaveBeenCalledOnce());
      const shouldApply = refreshAndRefetchMCPOAuthGrant.mock.calls[0]?.[2] as () => boolean;
      expect(shouldApply()).toBe(true);

      rerender(
        <MCPServerPill
          server={server}
          needsAuth={false}
          client={client}
          authorityKey={authorityKey}
          actionAllowed={actionAllowed}
          actionBlockedReason="OAuth unavailable"
        />
      );
      expect(shouldApply()).toBe(false);

      await act(async () => {
        releaseRefresh();
        await refreshPending;
      });
      expect(showSuccess).not.toHaveBeenCalled();
      if (!actionAllowed) {
        expect(
          screen.queryByRole('button', {
            name: 'Refresh OAuth credentials for OAuth Server',
          })
        ).not.toBeInTheDocument();
        expect(screen.getByText('OAuth Server').closest('.ant-tag')).toHaveStyle({
          cursor: 'default',
        });
      }
    }
  );

  it('guards refresh durable application when the pill unmounts during reads', async () => {
    let releaseRefresh!: () => void;
    const refreshPending = new Promise<{ success: true }>((resolve) => {
      releaseRefresh = () => resolve({ success: true });
    });
    refreshAndRefetchMCPOAuthGrant.mockImplementation(async () => refreshPending);
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000008',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      transport: 'http',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;
    const { unmount } = render(
      <MCPServerPill
        server={server}
        needsAuth={false}
        client={{} as AgorClient}
        authorityKey="user-a:member:1"
        actionAllowed
        actionBlockedReason="OAuth unavailable"
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh OAuth credentials for OAuth Server' })
    );
    await waitFor(() => expect(refreshAndRefetchMCPOAuthGrant).toHaveBeenCalledOnce());
    const shouldApply = refreshAndRefetchMCPOAuthGrant.mock.calls[0]?.[2] as () => boolean;
    unmount();
    expect(shouldApply()).toBe(false);

    releaseRefresh();
    await refreshPending;
    expect(showSuccess).not.toHaveBeenCalled();
  });
});
