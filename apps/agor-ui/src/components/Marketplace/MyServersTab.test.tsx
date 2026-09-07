import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyServersTab } from './MyServersTab';

const overview: MCPMarketplaceOverview = {
  servers: [
    {
      mcp_server_id: 'server-1',
      name: 'github',
      display_name: 'GitHub',
      source: 'user',
      transport: 'http',
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
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a dedicated empty state when the caller owns no servers', () => {
    render(
      <MyServersTab
        client={null}
        connected={false}
        connecting={false}
        authGeneration={0}
        currentUser={null}
        overview={{ ...overview, servers: [] }}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByText('You have no MCP servers yet')).toBeVisible();
    expect(
      screen.queryByText('Tool controls apply to future MCP configuration')
    ).not.toBeInTheDocument();
  });

  it('allows the server header and actions to wrap at narrow widths', async () => {
    const service = vi.fn((path: string) =>
      path === 'mcp-member-policy'
        ? { find: vi.fn(async () => ({ policy: 'allow_private_only', can_configure: true })) }
        : { create: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    );
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
        refresh={vi.fn(async () => undefined)}
      />
    );

    const title = screen.getByRole('heading', { name: 'GitHub' });
    const header = title.parentElement?.parentElement;
    expect(header).toHaveClass('ant-flex-wrap-wrap');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh tools for GitHub' })).toBeEnabled()
    );
  });

  it('surfaces a discover result failure without success or overview refresh', async () => {
    const create = vi.fn(async () => ({ success: false, error: 'Provider is unavailable' }));
    const service = vi.fn((path: string) =>
      path === 'mcp-member-policy'
        ? { find: vi.fn(async () => ({ policy: 'allow_private_only', can_configure: true })) }
        : { create, on: vi.fn(), removeListener: vi.fn() }
    );
    const refresh = vi.fn(async () => undefined);
    const success = vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
    const error = vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
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

    const button = screen.getByRole('button', { name: 'Refresh tools for GitHub' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(error).toHaveBeenCalledWith('Provider is unavailable'));
    expect(success).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

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

  it('allows owner refresh under use_existing_only but refuses configuration actions', async () => {
    const service = vi.fn((path: string) =>
      path === 'mcp-member-policy'
        ? { find: vi.fn(async () => ({ policy: 'use_existing_only', can_configure: false })) }
        : { create: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    );
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
        refresh={vi.fn(async () => undefined)}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh tools for GitHub' })).toBeEnabled()
    );
    expect(screen.getByRole('switch', { name: 'GitHub: issues.create on' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove GitHub' })).toBeDisabled();
  });

  it('accounts for transport separately across refresh, tools, and removal', async () => {
    const service = vi.fn((path: string) =>
      path === 'mcp-member-policy'
        ? { find: vi.fn(async () => ({ policy: 'allow_private_only', can_configure: true })) }
        : { create: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    );
    const stdioOverview: MCPMarketplaceOverview = {
      ...overview,
      servers: overview.servers.map((server) => ({ ...server, transport: 'stdio' })),
    };
    render(
      <MyServersTab
        client={{ service } as unknown as AgorClient}
        connected
        connecting={false}
        authGeneration={1}
        currentUser={{ user_id: 'alice', role: 'member' } as never}
        overview={stdioOverview}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove GitHub' })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: 'Refresh tools for GitHub' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'GitHub: issues.create on' })).toBeDisabled();
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
    await waitFor(() => {
      expect(remove).toBeEnabled();
      expect(
        screen.queryByText(/Checking what this workspace's MCP policy allows/i)
      ).not.toBeInTheDocument();
    });
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toHaveClass('ant-popover-open'), { timeout: 5_000 });

    view.rerender(
      <MyServersTab {...props} currentUser={{ user_id: 'alice', role: 'viewer' } as never} />
    );

    expect(screen.getByRole('switch', { name: 'GitHub: issues.create on' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh tools for GitHub' })).toBeDisabled();
    const demotedRemove = screen.getByRole('button', { name: 'Remove GitHub' });
    expect(demotedRemove).toBeDisabled();
    await waitFor(() => expect(demotedRemove).not.toHaveClass('ant-popover-open'), {
      timeout: 5_000,
    });

    // Losing the popover's open class is not the end of its work: rc-motion
    // runs an exit transition afterwards, and React 19 flushes the renders it
    // schedules from a macrotask (`performWorkUntilDeadline`, via
    // `setImmediate`). Returning here lets the file finish with that callback
    // still queued, and it then runs against a torn-down jsdom — surfacing as
    // an uncaught `ReferenceError: window is not defined` that fails the whole
    // shard even though all 997 assertions passed. Unmount so nothing further
    // is scheduled, then yield two macrotasks: the first lets the pending
    // `setImmediate` run (it is queued for the current loop iteration's check
    // phase, after timers), the second confirms the queue is drained — all
    // while the environment still exists.
    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
