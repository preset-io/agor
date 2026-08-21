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
    const service = vi.fn((path: string) =>
      path === 'mcp-member-policy'
        ? { find: vi.fn(async () => ({ policy: 'allow_private_only', can_configure: true })) }
        : { create, on: vi.fn(), removeListener: vi.fn() }
    );
    const refresh = vi.fn(async () => undefined);
    render(
      <MyServersTab
        client={{ service } as unknown as AgorClient}
        connected
        connecting={false}
        authGeneration={1}
        currentUser={{ user_id: 'alice', role: 'member' } as never}
        overview={overview}
        loading={false}
        error={null}
        refresh={refresh}
      />
    );

    const control = screen.getByRole('switch', { name: 'GitHub: issues.create on' });
    await waitFor(() => expect(control).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Refresh tools for GitHub' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove GitHub' })).toBeEnabled();
    fireEvent.click(control);
    await waitFor(() => expect(service).toHaveBeenCalledWith('mcp-marketplace/tool-permission'));
    expect(create).toHaveBeenCalledWith({
      mcp_server_id: 'server-1',
      tool_name: 'issues.create',
      enabled: false,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it('closes an open removal confirmation and disables controls on demotion', async () => {
    const service = vi.fn((path: string) =>
      path === 'mcp-member-policy'
        ? { find: vi.fn(async () => ({ policy: 'allow_private_only', can_configure: true })) }
        : { create: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    );
    const props = {
      client: { service } as unknown as AgorClient,
      connected: true,
      connecting: false,
      authGeneration: 1,
      overview,
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    const view = render(
      <MyServersTab {...props} currentUser={{ user_id: 'alice', role: 'member' } as never} />
    );
    const remove = screen.getByRole('button', { name: 'Remove GitHub' });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toHaveClass('ant-popover-open'));

    view.rerender(
      <MyServersTab {...props} currentUser={{ user_id: 'alice', role: 'viewer' } as never} />
    );

    expect(screen.getByRole('switch', { name: 'GitHub: issues.create on' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh tools for GitHub' })).toBeDisabled();
    const demotedRemove = screen.getByRole('button', { name: 'Remove GitHub' });
    expect(demotedRemove).toBeDisabled();
    await waitFor(() => expect(demotedRemove).not.toHaveClass('ant-popover-open'));
  });
});
