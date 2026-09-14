import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';

const permissionState = vi.hoisted(() => ({ isAdmin: true, role: 'admin' }));
const connectionState = vi.hoisted(() => ({
  connected: true,
  connecting: false,
  authGeneration: 1,
}));
const updateSessionMcpServers = vi.hoisted(() => vi.fn());
const showSuccess = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({
    ...permissionState,
    hasRole: () => permissionState.role !== 'viewer',
  }),
}));

vi.mock('@/contexts/ConnectionContext', () => ({
  useConnectionState: () => connectionState,
}));

vi.mock('@/utils/sessionMcpServers', () => ({ updateSessionMcpServers }));

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showSuccess, showError: vi.fn() }),
}));

vi.mock('../MCPServerSelect', () => ({
  MCPServerSelect: ({ onChange }: { onChange: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['replacement-server'])}>
      replace-session-mcp
    </button>
  ),
}));

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ConfigProvider>
    <App>{children}</App>
  </ConfigProvider>
);

const server = {
  mcp_server_id: '01900000-0000-7000-8000-000000000020',
  name: 'portal-server',
  display_name: 'Portal Server',
  description: 'Before',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  scope: 'global',
  enabled: true,
  auth: { type: 'none' },
} as MCPServer;

const patchServer = vi.fn();
const client = {
  service: vi.fn(() => ({ patch: patchServer, create: vi.fn() })),
  io: { on: vi.fn(), off: vi.fn() },
} as unknown as AgorClient;

describe('SessionMcpFooterControl overlay lifecycle', () => {
  beforeEach(() => {
    permissionState.isAdmin = true;
    permissionState.role = 'admin';
    connectionState.connected = true;
    connectionState.connecting = false;
    connectionState.authGeneration = 1;
    vi.clearAllMocks();
  });

  it('drops the attachment-save continuation when admin A is replaced by admin B', async () => {
    let resolveUpdate: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });
    updateSessionMcpServers.mockReturnValue(pending);
    const props = (currentUserId: string) => ({
      client,
      currentUserId,
      sessionId: 'session-id',
      sessionMcpServerIds: [server.mcp_server_id],
      mcpServerById: new Map([[server.mcp_server_id, server]]),
      userAuthenticatedMcpServerIds: new Set<string>(),
    });
    const rendered = render(<SessionMcpFooterControl {...props('user-a')} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'MCP servers. 1 MCP server attached. Open to add or change MCP servers.',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'replace-session-mcp' }));
    await waitFor(() => expect(updateSessionMcpServers).toHaveBeenCalledOnce());

    connectionState.authGeneration = 2;
    rendered.rerender(<SessionMcpFooterControl {...props('user-b')} />);
    resolveUpdate?.();
    await act(async () => pending);

    expect(showSuccess).not.toHaveBeenCalled();
    expect(updateSessionMcpServers).toHaveBeenCalledOnce();
  });

  it('keeps the portaled editor usable and restores disclosure behavior and focus', async () => {
    render(
      <SessionMcpFooterControl
        client={client}
        currentUserId="user-a"
        sessionId="session-id"
        sessionMcpServerIds={[server.mcp_server_id]}
        mcpServerById={new Map([[server.mcp_server_id, server]])}
        userAuthenticatedMcpServerIds={new Set()}
      />,
      { wrapper: Wrapper }
    );

    const disclosure = screen.getByRole('button', {
      name: 'MCP servers. 1 MCP server attached. Open to add or change MCP servers.',
    });
    fireEvent.click(disclosure);

    const mcpDialog = screen.getByRole('dialog', { name: 'Session MCP servers' });
    fireEvent.click(
      within(mcpDialog).getByRole('button', { name: 'Edit Portal Server MCP server' })
    );

    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: 'Session MCP servers' })).not.toBeInTheDocument();

    const editDialog = await screen.findByRole('dialog', { name: 'Edit MCP Server' });
    const displayName = await within(editDialog).findByLabelText('Display Name');
    act(() => displayName.focus());
    fireEvent.pointerDown(displayName);
    fireEvent.change(displayName, { target: { value: 'Portal Server Edited' } });

    expect(editDialog).toBeInTheDocument();
    expect(displayName).toHaveValue('Portal Server Edited');

    const cancel = within(editDialog).getByRole('button', { name: 'Cancel' });
    fireEvent.pointerDown(cancel);
    expect(editDialog).toBeInTheDocument();
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit MCP Server' })).not.toBeInTheDocument()
    );
    await waitFor(() => expect(disclosure).toHaveFocus());

    fireEvent.click(disclosure);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Session MCP servers' })).getByRole('button', {
        name: 'Edit Portal Server MCP server',
      })
    );
    await screen.findByRole('dialog', { name: 'Edit MCP Server' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit MCP Server' })).not.toBeInTheDocument()
    );
    await waitFor(() => expect(disclosure).toHaveFocus());

    fireEvent.click(disclosure);
    expect(screen.getByRole('dialog', { name: 'Session MCP servers' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Session MCP servers' })).not.toBeInTheDocument();
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  });

  it('fails an open editor closed across disconnect and demotion', async () => {
    const props = {
      client,
      currentUserId: 'user-a',
      sessionId: 'session-id',
      sessionMcpServerIds: [server.mcp_server_id],
      mcpServerById: new Map([[server.mcp_server_id, server]]),
      userAuthenticatedMcpServerIds: new Set<string>(),
    };
    const { rerender } = render(<SessionMcpFooterControl {...props} />, { wrapper: Wrapper });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'MCP servers. 1 MCP server attached. Open to add or change MCP servers.',
      })
    );
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Session MCP servers' })).getByRole('button', {
        name: 'Edit Portal Server MCP server',
      })
    );
    const editDialog = await screen.findByRole('dialog', { name: 'Edit MCP Server' });
    await waitFor(() =>
      expect(within(editDialog).getByRole('button', { name: 'Save' })).toBeEnabled()
    );

    connectionState.connected = false;
    connectionState.connecting = true;
    rerender(<SessionMcpFooterControl {...props} />);
    await waitFor(() =>
      expect(within(editDialog).getByText(/Reconnect to the Agor daemon/)).toBeVisible()
    );
    const save = within(editDialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(patchServer).not.toHaveBeenCalled();

    connectionState.connected = true;
    connectionState.connecting = false;
    permissionState.isAdmin = false;
    permissionState.role = 'viewer';
    rerender(<SessionMcpFooterControl {...props} />);
    await waitFor(() =>
      expect(within(editDialog).getByText(/account can no longer change/)).toBeVisible()
    );
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(patchServer).not.toHaveBeenCalled();
  });

  it('destroys the #2482-owned editor and its bearer secret on admin A -> admin B', async () => {
    const adminAServer = {
      ...server,
      name: 'admin-a-bearer',
      display_name: 'Admin A Bearer',
      auth: {
        type: 'bearer',
        token: 'admin-a-saved-secret',
      },
    } as MCPServer;
    const adminBServer = {
      ...server,
      mcp_server_id: '01900000-0000-7000-8000-000000000021',
      name: 'admin-b-server',
      display_name: 'Admin B Server',
    } as MCPServer;
    const props = (currentUserId: string, selectedServer: MCPServer) => ({
      client,
      currentUserId,
      sessionId: 'session-id',
      sessionMcpServerIds: [selectedServer.mcp_server_id],
      mcpServerById: new Map([[selectedServer.mcp_server_id, selectedServer]]),
      userAuthenticatedMcpServerIds: new Set<string>(),
    });
    const rendered = render(<SessionMcpFooterControl {...props('user-a', adminAServer)} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'MCP servers. 1 MCP server attached. Open to add or change MCP servers.',
      })
    );
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Session MCP servers' })).getByRole('button', {
        name: 'Edit Admin A Bearer MCP server',
      })
    );
    const editDialog = await screen.findByRole('dialog', { name: 'Edit MCP Server' });
    const clientSecret = await within(editDialog).findByLabelText('Token');
    fireEvent.change(clientSecret, { target: { value: 'admin-a-unsaved-secret' } });
    const staleSave = within(editDialog).getByRole('button', { name: 'Save' });

    connectionState.authGeneration = 2;
    rendered.rerender(<SessionMcpFooterControl {...props('user-b', adminBServer)} />);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit MCP Server' })).not.toBeInTheDocument()
    );
    expect(screen.queryByDisplayValue('admin-a-unsaved-secret')).not.toBeInTheDocument();
    fireEvent.click(staleSave);
    expect(patchServer).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'MCP servers. 1 MCP server attached. Open to add or change MCP servers.',
      })
    );
    const replacementDialog = screen.getByRole('dialog', { name: 'Session MCP servers' });
    expect(within(replacementDialog).getByText('Admin B Server')).toBeInTheDocument();
    expect(within(replacementDialog).queryByText('Admin A Bearer')).not.toBeInTheDocument();
  });
});
