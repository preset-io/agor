import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { AgorClient, MCPServer } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showSuccess = vi.fn();
const showError = vi.fn();
const preparedServerId = vi.fn();

type FormFieldsMockProps = {
  onPrepareOAuthStart: () => Promise<string | null>;
};

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({
    showSuccess,
    showError,
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

vi.mock('./MCPServerFormFields', async () => {
  const { Button, Form, Input } = await import('antd');
  return {
    MCPServerFormFields: ({ onPrepareOAuthStart }: FormFieldsMockProps) => (
      <>
        <Form.Item label="Description" name="description">
          <Input />
        </Form.Item>
        <Form.Item label="URL" name="url">
          <Input />
        </Form.Item>
        <Form.Item label="Client ID" name="oauth_client_id">
          <Input />
        </Form.Item>
        <Form.Item label="Client Secret" name="oauth_client_secret">
          <Input />
        </Form.Item>
        <Form.Item label="OAuth Compatibility" name="oauth_compatibility_mode">
          <Input />
        </Form.Item>
        <Form.Item label="Dynamic Client Registration" name="oauth_dcr_mode">
          <Input />
        </Form.Item>
        <Button onClick={() => void onPrepareOAuthStart().then(preparedServerId)}>
          Start OAuth Flow
        </Button>
      </>
    ),
  };
});

import { MCPServerEditModal } from './MCPServerEditModal';

describe('MCPServerEditModal legacy DCR compatibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps oauth_dcr_mode absent when an unrelated field is saved', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = {
      service: vi.fn().mockReturnValue({ patch }),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000001',
      name: 'legacy-notion',
      display_name: 'Legacy Notion',
      description: 'before',
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;

    render(
      <MCPServerEditModal
        server={server}
        open
        client={client}
        identityKey="user-a"
        authorityKey="user-a:admin:1"
        mutationAllowed
        onClose={vi.fn()}
      />
    );

    fireEvent.change(await screen.findByLabelText('Description'), {
      target: { value: 'after' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const updates = patch.mock.calls[0]?.[1] as { auth?: Record<string, unknown> };
    expect(updates.auth).not.toHaveProperty('oauth_dcr_mode');
    expect(updates.auth).not.toHaveProperty('oauth_compatibility_mode');
    expect(updates.auth).not.toHaveProperty('oauth_grant_type');
    expect(showSuccess).toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it.each(['Save', 'Start OAuth Flow'])(
    'hydrates and preserves a catalog-managed Marketplace policy during %s',
    async (action) => {
      const patch = vi.fn().mockResolvedValue({});
      const client = {
        service: vi.fn().mockReturnValue({ patch }),
        io: { on: vi.fn(), off: vi.fn() },
      } as unknown as AgorClient;
      const server = {
        mcp_server_id: '01900000-0000-7000-8000-000000000010',
        name: 'catalog-oauth',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        scope: 'global',
        source: 'catalog',
        catalog_entry_name: 'com.example/mcp',
        enabled: true,
        auth: { type: 'oauth' },
        oauth_compatibility_policy: {
          effective_mode: 'marketplace',
          managed_by_catalog: true,
        },
      } as MCPServer;

      render(
        <MCPServerEditModal
          server={server}
          open
          client={client}
          identityKey="user-a"
          authorityKey="user-a:admin:1"
          mutationAllowed
          onClose={vi.fn()}
        />
      );

      expect(await screen.findByLabelText('OAuth Compatibility')).toHaveValue('marketplace');
      fireEvent.click(screen.getByRole('button', { name: action }));

      await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
      const updates = patch.mock.calls[0]?.[1] as { auth?: Record<string, unknown> };
      expect(updates.auth).not.toHaveProperty('oauth_compatibility_mode');
    }
  );

  it('persists edited OAuth client credentials before the first OAuth start', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    const client = {
      service: vi.fn().mockReturnValue({ patch }),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000002',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      description: 'server',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      scope: 'global',
      enabled: true,
      auth: {
        type: 'oauth',
        oauth_client_id: 'stale-client-id',
        oauth_client_secret: 'stale-client-secret',
      },
    } as MCPServer;

    render(
      <MCPServerEditModal
        server={server}
        open
        client={client}
        identityKey="user-a"
        authorityKey="user-a:admin:1"
        mutationAllowed
        onClose={onClose}
      />
    );

    fireEvent.change(await screen.findByLabelText('Client ID'), {
      target: { value: 'fresh-client-id' },
    });
    fireEvent.change(screen.getByLabelText('Client Secret'), {
      target: { value: 'fresh-client-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start OAuth Flow' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const updates = patch.mock.calls[0]?.[1] as { auth?: Record<string, unknown> };
    expect(updates.auth).toMatchObject({
      type: 'oauth',
      oauth_client_id: 'fresh-client-id',
      oauth_client_secret: 'fresh-client-secret',
    });
    expect(updates.auth).not.toHaveProperty('oauth_compatibility_mode');
    expect(updates.auth).not.toHaveProperty('oauth_grant_type');
    expect(onClose).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('round-trips a redacted OAuth client secret before the first OAuth start', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = {
      service: vi.fn().mockReturnValue({ patch }),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000003',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      description: 'server',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      scope: 'global',
      enabled: true,
      auth: {
        type: 'oauth',
        oauth_client_id: 'stale-client-id',
        oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
      },
    } as MCPServer;

    render(
      <MCPServerEditModal
        server={server}
        open
        client={client}
        identityKey="user-a"
        authorityKey="user-a:admin:1"
        mutationAllowed
        onClose={vi.fn()}
      />
    );

    fireEvent.change(await screen.findByLabelText('Client ID'), {
      target: { value: 'fresh-client-id' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start OAuth Flow' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const updates = patch.mock.calls[0]?.[1] as { auth?: Record<string, unknown> };
    expect(updates.auth).toMatchObject({
      type: 'oauth',
      oauth_client_id: 'fresh-client-id',
      oauth_client_secret: MCP_HEADER_REDACTED_SENTINEL,
    });
    expect(showError).not.toHaveBeenCalled();
  });

  // #2332: the flow used to authorize against the last saved row, so an unsaved
  // URL / compatibility / DCR edit made "Test Authentication" pass and the flow
  // fail. The prepared ID must come back only after those values are persisted.
  it('persists pending URL and OAuth mode edits before returning the server ID', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = {
      service: vi.fn().mockReturnValue({ patch }),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000004',
      name: 'oauth-server',
      transport: 'http',
      url: 'https://old.example/mcp',
      scope: 'global',
      enabled: true,
      auth: {
        type: 'oauth',
        oauth_compatibility_mode: 'strict',
        oauth_dcr_mode: 'advertised',
      },
    } as MCPServer;

    render(
      <MCPServerEditModal
        server={server}
        open
        client={client}
        identityKey="user-a"
        authorityKey="user-a:admin:1"
        mutationAllowed
        onClose={vi.fn()}
      />
    );

    fireEvent.change(await screen.findByLabelText('URL'), {
      target: { value: 'https://current.example/mcp' },
    });
    fireEvent.change(screen.getByLabelText('OAuth Compatibility'), {
      target: { value: 'legacy' },
    });
    fireEvent.change(screen.getByLabelText('Dynamic Client Registration'), {
      target: { value: 'fallback' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start OAuth Flow' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(
      server.mcp_server_id,
      expect.objectContaining({
        url: 'https://current.example/mcp',
        auth: expect.objectContaining({
          type: 'oauth',
          oauth_compatibility_mode: 'legacy',
          oauth_dcr_mode: 'fallback',
        }),
      })
    );
    await waitFor(() => expect(preparedServerId).toHaveBeenCalledWith(server.mcp_server_id));
    expect(showError).not.toHaveBeenCalled();
  });

  it('remounts same-server OAuth form state across admin A -> admin B', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = {
      service: vi.fn().mockReturnValue({ patch }),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const serverA = {
      mcp_server_id: '01900000-0000-7000-8000-000000000050',
      name: 'same-server-id',
      transport: 'http',
      url: 'https://same.example/mcp',
      scope: 'global',
      enabled: true,
      auth: {
        type: 'oauth',
        oauth_client_id: 'admin-a-client',
        oauth_client_secret: 'admin-a-saved-secret',
      },
    } as MCPServer;
    const serverB = {
      ...serverA,
      auth: {
        type: 'oauth',
        oauth_client_id: 'admin-b-client',
        oauth_client_secret: 'admin-b-saved-secret',
      },
    } as MCPServer;
    const view = (identityKey: string, server: MCPServer) => (
      <MCPServerEditModal
        server={server}
        open
        client={client}
        identityKey={identityKey}
        authorityKey={`${identityKey}:admin:2`}
        mutationAllowed
        onClose={vi.fn()}
      />
    );
    const rendered = render(view('admin-a', serverA));
    const secret = await screen.findByLabelText('Client Secret');
    fireEvent.change(secret, { target: { value: 'admin-a-unsaved-secret' } });
    const staleSave = screen.getByRole('button', { name: 'Save' });

    rendered.rerender(view('admin-b', serverB));

    await waitFor(() =>
      expect(screen.getByLabelText('Client Secret')).toHaveValue('admin-b-saved-secret')
    );
    expect(screen.queryByDisplayValue('admin-a-unsaved-secret')).not.toBeInTheDocument();
    fireEvent.click(staleSave);
    expect(patch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(
      serverB.mcp_server_id,
      expect.objectContaining({
        auth: expect.objectContaining({
          oauth_client_id: 'admin-b-client',
          oauth_client_secret: 'admin-b-saved-secret',
        }),
      })
    );
  });

  it.each(['Save', 'Start OAuth Flow'])(
    'blocks %s after authority is lost while the edit dialog remains open',
    async (action) => {
      const patch = vi.fn().mockResolvedValue({});
      const client = {
        service: vi.fn().mockReturnValue({ patch }),
        io: { on: vi.fn(), off: vi.fn() },
      } as unknown as AgorClient;
      const server = {
        mcp_server_id: '01900000-0000-7000-8000-000000000099',
        name: 'transition-oauth',
        transport: 'http',
        url: 'https://transition.example/mcp',
        scope: 'global',
        enabled: true,
        auth: { type: 'oauth' },
      } as MCPServer;
      const view = (mutationAllowed: boolean) => (
        <MCPServerEditModal
          server={server}
          open
          client={client}
          identityKey="user-a"
          authorityKey={mutationAllowed ? 'user-a:admin:1' : null}
          mutationAllowed={mutationAllowed}
          mutationBlockedReason="Connection authority changed"
          onClose={vi.fn()}
        />
      );
      const rendered = render(view(true));
      await screen.findByLabelText('URL');

      rendered.rerender(view(false));
      fireEvent.click(screen.getByRole('button', { name: action }));

      expect(patch).not.toHaveBeenCalled();
      expect(preparedServerId).not.toHaveBeenCalled();
      if (action === 'Save') {
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      }
    }
  );
});
