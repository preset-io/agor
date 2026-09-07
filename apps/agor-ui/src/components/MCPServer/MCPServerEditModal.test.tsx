import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { AgorClient, MCPServer } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showSuccess = vi.fn();
const showError = vi.fn();
const preparedServerId = vi.fn();

type FormFieldsMockProps = {
  onPrepareOAuthStart: () => Promise<string | null>;
  onTestConnection: () => Promise<void>;
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
  const { Button, Form, Input, Switch } = await import('antd');
  return {
    MCPServerFormFields: ({ onPrepareOAuthStart, onTestConnection }: FormFieldsMockProps) => (
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
        <Form.Item label="Enabled" name="enabled" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Button onClick={() => void onPrepareOAuthStart().then(preparedServerId)}>
          Start OAuth Flow
        </Button>
        <Button onClick={() => void onTestConnection()}>Test Connection</Button>
      </>
    ),
  };
});

import { MCPServerEditModal } from './MCPServerEditModal';

describe('MCPServerEditModal legacy DCR compatibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires destructive confirmation before disabling an OAuth server', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = {
      service: vi.fn().mockReturnValue({ patch }),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000099',
      name: 'oauth-disable',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
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
        authGeneration={1}
        mutationAllowed
        onClose={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('switch', { name: 'Enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText('Disable this OAuth server?')).length).toBeGreaterThan(0);
    expect(patch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Disable server' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
  });

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
        authGeneration={1}
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
          authGeneration={1}
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
        authGeneration={1}
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
        authGeneration={1}
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
        authGeneration={1}
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
        authGeneration={2}
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

  it('drops a delayed saved-server discovery browser event across admin A -> admin B', async () => {
    let resolveDiscover: ((value: { success: boolean }) => void) | undefined;
    const discover = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveDiscover = resolve;
        })
    );
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const reserve = vi.fn().mockResolvedValue({
      reservation_token: 'server-reservation-admin-a-00000001',
      expires_at: Date.now() + 60_000,
    });
    const client = {
      service: vi.fn((path: string) => {
        if (path === 'mcp-servers/discover') return { create: discover };
        if (path === 'mcp-servers/oauth-browser-reservations') return { create: reserve };
        return { patch: vi.fn() };
      }),
      io: {
        on: vi.fn((_event: string, listener: (event: Record<string, unknown>) => void) =>
          listeners.add(listener)
        ),
        off: vi.fn((_event: string, listener: (event: Record<string, unknown>) => void) =>
          listeners.delete(listener)
        ),
      },
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000060',
      name: 'delayed-oauth',
      transport: 'http',
      url: 'https://delayed.example/mcp',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const view = (identityKey: string, authGeneration: number) => (
      <MCPServerEditModal
        server={server}
        open
        client={client}
        identityKey={identityKey}
        authorityKey={`${identityKey}:admin:${authGeneration}`}
        authGeneration={authGeneration}
        mutationAllowed
        onClose={vi.fn()}
      />
    );
    const rendered = render(view('admin-a', 31));
    await screen.findByLabelText('URL');
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(discover).toHaveBeenCalledOnce());
    const request = discover.mock.calls[0]?.[0] as {
      oauth_browser_event: { reservation_token: string };
    };
    expect(reserve).toHaveBeenCalledWith({
      operation: 'discover',
      mcp_server_id: server.mcp_server_id,
    });
    expect(listeners.size).toBe(1);
    // Socket.IO may already have snapshotted a callback for dispatch when the
    // identity commit removes it. Exercise that queued callback directly.
    const queuedListeners = [...listeners];

    rendered.rerender(view('admin-b', 32));
    expect(listeners.size).toBe(0);
    for (const listener of queuedListeners) {
      listener({
        authUrl: 'https://provider.example/admin-a',
        attempt_id: 'attempt-admin-a',
        reservation_token: request.oauth_browser_event.reservation_token,
        caller_user_id: 'admin-a',
      });
    }
    resolveDiscover?.({ success: true });
    await Promise.resolve();

    expect(open).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledOnce();
    open.mockRestore();
  });

  it('reloads fresh catalog policy after a CAS conflict without overwriting it on retry', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      code: 409,
      data: { current_config_version: 9 },
    });
    const patch = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ config_version: 10 });
    const latest = {
      mcp_server_id: '01900000-0000-7000-8000-000000000088',
      name: 'managed-after-conflict',
      description: 'edited elsewhere',
      transport: 'http',
      url: 'https://managed.example/mcp',
      scope: 'global',
      source: 'catalog',
      catalog_entry_name: 'com.example/managed',
      enabled: true,
      config_version: 9,
      auth: { type: 'oauth' },
      oauth_compatibility_policy: {
        effective_mode: 'marketplace',
        managed_by_catalog: true,
      },
    } as MCPServer;
    const get = vi.fn().mockResolvedValue(latest);
    const client = {
      service: vi.fn(() => ({ patch, get })),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const stale = {
      ...latest,
      description: 'stale local copy',
      config_version: 8,
      source: 'user',
      catalog_entry_name: undefined,
      oauth_compatibility_policy: undefined,
      auth: { type: 'oauth', oauth_compatibility_mode: 'strict' },
    } as MCPServer;

    render(
      <MCPServerEditModal
        server={stale}
        open
        client={client}
        identityKey="user-a"
        authorityKey="user-a:admin:1"
        authGeneration={1}
        mutationAllowed
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Newer MCP settings are available');
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Description')).toHaveValue('edited elsewhere')
    );
    expect(screen.getByLabelText('OAuth Compatibility')).toHaveValue('marketplace');

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'retry edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    const retry = patch.mock.calls[1]?.[1] as { expected_config_version: number; auth: object };
    expect(retry.expected_config_version).toBe(9);
    expect(retry.auth).not.toHaveProperty('oauth_compatibility_mode');
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
          authGeneration={1}
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
