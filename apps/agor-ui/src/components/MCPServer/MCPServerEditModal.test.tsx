import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { AgorClient, MCPServer } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showSuccess = vi.fn();
const showError = vi.fn();

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
        <Form.Item label="Client ID" name="oauth_client_id">
          <Input />
        </Form.Item>
        <Form.Item label="Client Secret" name="oauth_client_secret">
          <Input />
        </Form.Item>
        <Button onClick={() => void onPrepareOAuthStart()}>Start OAuth Flow</Button>
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

    render(<MCPServerEditModal server={server} open client={client} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Description'), {
      target: { value: 'after' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const updates = patch.mock.calls[0]?.[1] as { auth?: Record<string, unknown> };
    expect(updates.auth).not.toHaveProperty('oauth_dcr_mode');
    expect(showSuccess).toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

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

    render(<MCPServerEditModal server={server} open client={client} onClose={onClose} />);

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

    render(<MCPServerEditModal server={server} open client={client} onClose={vi.fn()} />);

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
});
