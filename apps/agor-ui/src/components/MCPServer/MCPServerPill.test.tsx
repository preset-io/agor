import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerPill } from './MCPServerPill';

const refreshAndRefetchMCPOAuthGrant = vi.hoisted(() => vi.fn());
const showError = vi.fn();
const showInfo = vi.fn();
const showSuccess = vi.fn();
const showWarning = vi.fn();

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
  });

  it('uses the shared OAuth start path and exposes sanitized DCR recovery', async () => {
    const startOAuth = vi.fn().mockResolvedValue({
      success: false,
      error: 'The provider could not register an OAuth client automatically.',
      recovery: {
        category: 'client_registration_failed',
        action: 'configure_client',
        message: 'The provider could not register an OAuth client automatically.',
        redirect_uri: 'https://agor.example.com/mcp-servers/oauth-callback',
      },
    });
    const client = {
      service: vi.fn(() => ({ create: startOAuth })),
    } as unknown as AgorClient;
    const onEdit = vi.fn();
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
        configureAllowed
        configureBlockedReason="Only an administrator can change saved credentials."
        onEdit={onEdit}
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
    const configure = screen.getByRole('button', { name: 'Configure OAuth client' });
    expect(configure).toBeVisible();
    fireEvent.click(configure);
    expect(onEdit).toHaveBeenCalledWith(server);
    expect(screen.getByText(/mcp-servers\/oauth-callback/)).toBeVisible();
    expect(screen.queryByText(/dcr_registration|HTTP 404/)).not.toBeInTheDocument();
  });

  it.each([
    ['bearer', { type: 'bearer' as const }],
    ['JWT', { type: 'jwt' as const, api_url: 'https://auth.example.test/token' }],
  ])(
    'opens configuration, never OAuth, for a %s server with a cleared secret',
    async (_label, auth) => {
      const service = vi.fn();
      const client = { service } as unknown as AgorClient;
      const onEdit = vi.fn();
      const server = {
        mcp_server_id: '01900000-0000-7000-8000-000000000014',
        name: 'static-auth-server',
        display_name: 'Static Auth Server',
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        scope: 'global',
        enabled: true,
        auth,
      } as MCPServer;

      const { container } = render(
        <MCPServerPill
          server={server}
          needsAuth
          client={client}
          authorityKey="user-a:member:1"
          actionAllowed
          actionBlockedReason="OAuth unavailable"
          configureAllowed
          configureBlockedReason="Only an administrator can change saved credentials."
          onEdit={onEdit}
        />
      );

      const configure = screen.getByRole('button', {
        name: 'Needs configuration: Static Auth Server',
      });
      expect(configure).toHaveAccessibleName('Needs configuration: Static Auth Server');
      expect(container.querySelector('.anticon-setting')).toBeInTheDocument();

      // A browser-generated keyboard click has detail=0. Exercising the
      // native button path proves it is not pointer-only.
      act(() => configure.focus());
      expect(configure).toHaveFocus();
      fireEvent.click(configure, { detail: 0 });

      expect(onEdit).toHaveBeenCalledOnce();
      expect(onEdit).toHaveBeenCalledWith(server);
      expect(service).not.toHaveBeenCalled();

      fireEvent.mouseEnter(configure);
      expect(
        await screen.findByText(/needs configuration.*activate to configure/i)
      ).toBeInTheDocument();
    }
  );

  it.each(['bearer', 'jwt'] as const)(
    'does not offer %s configuration to a viewer without mutation authority',
    (type) => {
      const service = vi.fn();
      const onEdit = vi.fn();
      const server = {
        mcp_server_id: '01900000-0000-7000-8000-000000000015',
        name: 'restricted-static-auth',
        display_name: 'Restricted Credentials',
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        scope: 'global',
        enabled: true,
        auth:
          type === 'bearer'
            ? { type: 'bearer' as const }
            : { type: 'jwt' as const, api_url: 'https://auth.example.test/token' },
      } as MCPServer;

      render(
        <MCPServerPill
          server={server}
          needsAuth
          client={{ service } as unknown as AgorClient}
          authorityKey="viewer:1"
          actionAllowed={false}
          actionBlockedReason="OAuth unavailable"
          configureAllowed={false}
          configureBlockedReason="Only an administrator can change saved credentials."
          onEdit={onEdit}
        />
      );

      const status = screen.getByRole('button', {
        name: /Restricted Credentials MCP server\. Needs configuration\. Only an administrator/i,
      });
      expect(status).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(status);
      expect(onEdit).not.toHaveBeenCalled();
      expect(service).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('button', { name: 'Edit Restricted Credentials MCP server' })
      ).not.toBeInTheDocument();
    }
  );

  it('names the admin edit action for the server it edits', () => {
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
        configureAllowed
        configureBlockedReason="Only an administrator can change saved credentials."
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
        configureAllowed
        configureBlockedReason="Only an administrator can change saved credentials."
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

  it('uses a real visually-hidden live region and announces transitions, not initial ready state', async () => {
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000009',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      transport: 'http',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;
    const common = {
      server,
      client: {} as AgorClient,
      authorityKey: 'user-a:member:1',
      actionAllowed: true,
      actionBlockedReason: 'OAuth unavailable',
      configureAllowed: true,
      configureBlockedReason: 'Only an administrator can change saved credentials.',
    };
    const { container, rerender } = render(<MCPServerPill {...common} needsAuth={false} />);

    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveTextContent('');
    expect(liveRegion).not.toHaveClass('sr-only');
    expect(liveRegion).toHaveStyle({
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      clipPath: 'inset(50%)',
    });

    rerender(<MCPServerPill {...common} needsAuth />);
    await waitFor(() =>
      expect(liveRegion).toHaveTextContent('OAuth Server requires authentication.')
    );

    rerender(<MCPServerPill {...common} needsAuth={false} />);
    await waitFor(() => expect(liveRegion).toHaveTextContent('OAuth Server is ready.'));
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
          configureAllowed
          configureBlockedReason="Only an administrator can change saved credentials."
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
          configureAllowed
          configureBlockedReason="Only an administrator can change saved credentials."
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
        configureAllowed
        configureBlockedReason="Only an administrator can change saved credentials."
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
