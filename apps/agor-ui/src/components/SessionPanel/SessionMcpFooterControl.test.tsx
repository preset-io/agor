import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';

const permissionState = vi.hoisted(() => ({ isAdmin: true }));

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => permissionState,
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

const client = {
  service: vi.fn(() => ({ patch: vi.fn(), create: vi.fn() })),
  io: { on: vi.fn(), off: vi.fn() },
} as unknown as AgorClient;

describe('SessionMcpFooterControl overlay lifecycle', () => {
  beforeEach(() => {
    permissionState.isAdmin = true;
    vi.clearAllMocks();
  });

  it('keeps the portaled editor usable and restores disclosure behavior and focus', async () => {
    render(
      <SessionMcpFooterControl
        client={client}
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
});
