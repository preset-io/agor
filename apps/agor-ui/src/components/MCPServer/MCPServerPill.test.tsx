import type { AgorClient, MCPServer } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

    render(<MCPServerPill server={server} needsAuth client={client} />);

    const signIn = screen.getByRole('button', { name: 'Sign in to OAuth Server' });
    expect(signIn.tagName).toBe('BUTTON');
    signIn.focus();
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
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000005',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      transport: 'http',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;

    render(<MCPServerPill server={server} needsAuth client={null} />);

    expect(
      screen.getByRole('button', { name: 'Edit OAuth Server MCP server' })
    ).toBeInTheDocument();
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

    render(<MCPServerPill server={server} needsAuth={false} client={client} />);

    const refresh = screen.getByRole('button', {
      name: 'Refresh OAuth credentials for OAuth Server',
    });
    expect(refresh.tagName).toBe('BUTTON');
    refresh.focus();
    expect(refresh).toHaveFocus();
    fireEvent.click(refresh);

    await waitFor(() =>
      expect(refreshAndRefetchMCPOAuthGrant).toHaveBeenCalledWith(
        client,
        '01900000-0000-7000-8000-000000000006'
      )
    );
  });
});
