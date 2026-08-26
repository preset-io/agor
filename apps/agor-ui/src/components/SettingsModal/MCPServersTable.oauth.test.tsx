import type { AgorClient, MCPServer, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';

const showError = vi.fn();

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showError }),
}));

vi.mock('../MCPServer', () => ({
  MCPServerEditModal: () => null,
  MCPServerFormFields: ({
    form,
    onAuthTypeChange,
    onPrepareOAuthStart,
    serverId,
  }: {
    form: { setFieldsValue: (values: Record<string, unknown>) => void };
    onAuthTypeChange?: (authType: 'oauth') => void;
    onPrepareOAuthStart: () => Promise<string | null>;
    serverId?: string;
  }) => (
    <>
      <Button
        onClick={() => {
          form.setFieldsValue({
            name: 'hubspot',
            display_name: 'HubSpot',
            transport: 'http',
            url: 'https://mcp.hubspot.com',
            scope: 'global',
            enabled: true,
            auth_type: 'oauth',
            oauth_mode: 'per_user',
            oauth_compatibility_mode: 'strict',
            oauth_dcr_mode: 'advertised',
          });
          onAuthTypeChange?.('oauth');
        }}
      >
        Configure OAuth
      </Button>
      <Button onClick={() => void onPrepareOAuthStart()}>Prepare OAuth</Button>
      <span data-testid="prepared-server-id">{serverId ?? 'none'}</span>
    </>
  ),
}));

import { MCPServersTable } from './MCPServersTable';

const ADMIN = {
  user_id: 'user-admin',
  email: 'admin@agor.live',
  name: 'Ada Admin',
  role: 'admin',
} as User;

describe('MCPServersTable OAuth creation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates once, patches before retry, and forgets the ID after close', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ mcp_server_id: 'server-1' } as MCPServer)
      .mockResolvedValueOnce({ mcp_server_id: 'server-2' } as MCPServer);
    const patch = vi.fn().mockResolvedValue({});
    const client = {
      service: vi.fn((path: string) =>
        path === 'mcp-member-policy'
          ? {
              find: vi.fn().mockResolvedValue({
                policy: 'use_existing_only',
                can_configure: true,
              }),
            }
          : { create, patch, on: vi.fn(), removeListener: vi.fn() }
      ),
    } as unknown as AgorClient;

    render(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <MCPServersTable
          mcpServerById={new Map()}
          client={client}
          userById={new Map([[ADMIN.user_id, ADMIN]])}
          currentUser={ADMIN}
          onCreate={vi.fn()}
          onDelete={vi.fn()}
        />
      </ConnectionProvider>
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /New MCP Server/ })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: /New MCP Server/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Configure OAuth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare OAuth' }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(await screen.findByTestId('prepared-server-id')).toHaveTextContent('server-1');

    fireEvent.click(screen.getByRole('button', { name: 'Prepare OAuth' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('server-1', expect.any(Object)));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /New MCP Server/ }));
    expect(await screen.findByTestId('prepared-server-id')).toHaveTextContent('none');

    fireEvent.click(screen.getByRole('button', { name: 'Configure OAuth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare OAuth' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('prepared-server-id')).toHaveTextContent('server-2');
    expect(patch).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  }, 30_000);
});
