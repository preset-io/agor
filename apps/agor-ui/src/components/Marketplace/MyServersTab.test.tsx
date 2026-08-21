import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MyServersTab } from './MyServersTab';

const overview: MCPMarketplaceOverview = {
  servers: [
    {
      mcp_server_id: 'server-1',
      name: 'github',
      display_name: 'GitHub',
      source: 'user',
      enabled: true,
      tools: [{ name: 'issues.create', description: 'Create an issue', permission: 'default' }],
      session_count: 0,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    },
  ],
  attachments: [],
  credentials: [],
  generated_at: new Date(0).toISOString(),
};

describe('Marketplace server actions', () => {
  it('uses contextual tool labels and the narrow atomic permission action', async () => {
    const create = vi.fn(async () => ({ permission: 'deny' }));
    const service = vi.fn(() => ({ create }));
    const refresh = vi.fn(async () => undefined);
    render(
      <MyServersTab
        client={{ service } as unknown as AgorClient}
        authorityKey={['alice', 'member', 1]}
        overview={overview}
        loading={false}
        error={null}
        refresh={refresh}
      />
    );

    fireEvent.click(screen.getByRole('switch', { name: 'GitHub: issues.create on' }));
    await waitFor(() => expect(service).toHaveBeenCalledWith('mcp-marketplace/tool-permission'));
    expect(create).toHaveBeenCalledWith({
      mcp_server_id: 'server-1',
      tool_name: 'issues.create',
      enabled: false,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });
});
