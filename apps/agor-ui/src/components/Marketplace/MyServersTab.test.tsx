import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  credentials: [
    {
      mcp_server_id: 'server-1',
      server_name: 'github',
      server_display_name: 'GitHub',
      method: 'oauth',
      status: 'active',
    },
  ],
  generated_at: new Date(0).toISOString(),
};

function client(policy = 'allow_private_only', canConfigure = true) {
  const create = vi.fn(async () => ({ success: true }));
  const get = vi.fn(async (mcpServerId: string) => ({
    mcp_server_id: mcpServerId,
    name: 'github',
    display_name: 'GitHub',
    transport: 'http',
    url: 'https://example.invalid/mcp',
    scope: 'session',
    enabled: true,
    source: 'user',
    auth: { type: 'bearer', token: '••••••••' },
    config_version: 1,
    created_at: new Date(0),
    updated_at: new Date(0),
  }));
  const service = vi.fn((path: string) =>
    path === 'mcp-member-policy'
      ? { find: vi.fn(async () => ({ policy, can_configure: canConfigure })) }
      : { create, get, on: vi.fn(), removeListener: vi.fn() }
  );
  return { value: { service } as unknown as AgorClient, service, create, get };
}

function renderTab(
  value: MCPMarketplaceOverview = overview,
  options: { policy?: string; canConfigure?: boolean } = {}
) {
  const mocked = client(options.policy, options.canConfigure);
  const refresh = vi.fn(async () => undefined);
  render(
    <MyServersTab
      client={mocked.value}
      connected
      connecting={false}
      authGeneration={1}
      currentUser={{ user_id: 'alice', role: 'member' } as never}
      overview={value}
      loading={false}
      error={null}
      refresh={refresh}
    />
  );
  return { ...mocked, refresh };
}

describe('Marketplace server inventory and settings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders a production empty state with a catalog route action', () => {
    const browse = vi.fn();
    render(
      <MyServersTab
        client={null}
        connected={false}
        connecting={false}
        authGeneration={0}
        currentUser={null}
        overview={{ ...overview, servers: [], credentials: [] }}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
        onBrowseCatalog={browse}
      />
    );

    expect(screen.getByText('No MCP servers installed')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Browse catalog' }));
    expect(browse).toHaveBeenCalledOnce();
  });

  it('keeps loading distinct from empty and offers recovery after an overview error', () => {
    const empty = { ...overview, servers: [], credentials: [] };
    const refresh = vi.fn(async () => undefined);
    const props = {
      client: null,
      connected: false,
      connecting: false,
      authGeneration: 0,
      currentUser: null,
      overview: empty,
      refresh,
    };
    const view = render(<MyServersTab {...props} loading error={null} />);

    expect(screen.queryByText('No MCP servers installed')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Installed MCP servers' })).toBeInTheDocument();

    view.rerender(<MyServersTab {...props} loading={false} error="Overview read failed" />);
    expect(screen.getByText('Could not load your servers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('shows concise truthful inventory columns without inventing update state', async () => {
    renderTab();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('table', { name: 'Installed MCP servers' })).toBeVisible();
    expect(screen.getByText('Connected')).toBeVisible();
    expect(screen.getByText('1 of 1 enabled')).toBeVisible();
    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
  });

  it('describes a healthy open server as needing no account', async () => {
    renderTab({ ...overview, credentials: [] });
    await waitFor(() => expect(screen.getByText('No account needed')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    expect(await screen.findAllByText('No account needed')).not.toHaveLength(0);
    expect(screen.queryByText('No credential status')).not.toBeInTheDocument();
  });

  it('shows disabled separately without contradicting a healthy OAuth grant', async () => {
    renderTab({
      ...overview,
      servers: [{ ...overview.servers[0], enabled: false }],
    });
    await waitFor(() => expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0));
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getAllByText('Disabled').length).toBeGreaterThan(0);
    expect(within(drawer).queryByText('OAuth · Connected')).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /Reconnect/ })).not.toBeInTheDocument();
  });

  it('opens the existing secure credential editor even with no session attachments', async () => {
    const value: MCPMarketplaceOverview = {
      ...overview,
      credentials: [
        {
          ...overview.credentials[0],
          method: 'bearer',
          status: 'configured',
        },
      ],
    };
    const { service, get } = renderTab(value);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('No sessions are attached.')).toBeVisible();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit GitHub credential' }));

    await waitFor(() => expect(service).toHaveBeenCalledWith('mcp-servers'));
    expect(get).toHaveBeenCalledWith('server-1');
    expect(await screen.findByText('Edit MCP Server')).toBeInTheDocument();
  });

  it('gives each settings action a contextual accessible name', async () => {
    renderTab({
      ...overview,
      servers: [
        overview.servers[0],
        {
          ...overview.servers[0],
          mcp_server_id: 'server-2',
          name: 'linear',
          display_name: 'Linear',
        },
      ],
    });

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Settings for GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings for Linear' })).toBeInTheDocument();
  });

  it('restores focus to the connected settings trigger after close', async () => {
    renderTab();
    const trigger = screen.getByRole('button', { name: 'Settings for GitHub' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('opens settings with tools, redacted credential summary, sessions, and secure recovery', async () => {
    const secret = 'oauth-live-secret-that-must-not-render';
    const value = {
      ...overview,
      servers: [{ ...overview.servers[0], session_count: 1 }],
      attachments: [
        {
          session_id: 'session-1',
          mcp_server_id: 'server-1',
          enabled: false,
          added_at: new Date(0).toISOString(),
          session_title: 'Triage bugs',
          session_status: 'idle',
          agentic_tool: 'claude-code',
          branch_id: 'branch-1',
          branch_name: 'fixes',
        },
      ],
      credentials: [
        {
          ...overview.credentials[0],
          status: 'reauthentication_required',
          oauth_access_token: secret,
          masked_token: '••••1234',
        },
      ],
    } as unknown as MCPMarketplaceOverview;
    const { service } = renderTab(value);

    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Enabled tools')).toBeInTheDocument();
    expect(within(drawer).getByText('Triage bugs · Disabled')).toBeInTheDocument();
    expect(within(drawer).getByText('OAuth · Reconnect required')).toBeInTheDocument();
    expect(drawer).not.toHaveTextContent(secret);
    expect(drawer).not.toHaveTextContent('••••1234');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Reconnect GitHub account' }));
    await waitFor(() => expect(service).toHaveBeenCalledWith('mcp-servers/oauth-start'));
    expect(within(drawer).getByRole('button', { name: 'Remove GitHub server' })).toBeDisabled();
  });

  it('uses the narrow atomic tool-permission action from the settings drawer', async () => {
    const { service, create, refresh } = renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const control = await screen.findByRole('switch', { name: 'GitHub: issues.create on' });
    await waitFor(() => expect(control).toBeEnabled());
    fireEvent.click(control);

    await waitFor(() => expect(service).toHaveBeenCalledWith('mcp-marketplace/tool-permission'));
    expect(create).toHaveBeenCalledWith({
      mcp_server_id: 'server-1',
      tool_name: 'issues.create',
      enabled: false,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it('surfaces tool discovery failures without claiming success', async () => {
    const error = vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
    const success = vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
    const mocked = client();
    mocked.create.mockResolvedValue({ success: false, error: 'Provider is unavailable' });
    const refresh = vi.fn(async () => undefined);
    render(
      <MyServersTab
        client={mocked.value}
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
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const refreshTools = await screen.findByRole('button', { name: 'Refresh tools' });
    await waitFor(() => expect(refreshTools).toBeEnabled());
    fireEvent.click(refreshTools);

    await waitFor(() => expect(error).toHaveBeenCalledWith('Provider is unavailable'));
    expect(success).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('fails closed when member policy permits reuse but not configuration', async () => {
    renderTab(overview, { policy: 'use_existing_only', canConfigure: false });
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const tool = await screen.findByRole('switch', { name: 'GitHub: issues.create on' });
    await waitFor(() => expect(tool).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Remove GitHub server' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh tools' })).toBeEnabled();
  });

  it('keeps transport authority narrow for member-owned stdio servers', async () => {
    renderTab({
      ...overview,
      servers: [{ ...overview.servers[0], transport: 'stdio' }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    expect(await screen.findByRole('button', { name: 'Refresh tools' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'GitHub: issues.create on' })).toBeDisabled();
  });

  it('closes an open removal confirmation when authority is demoted', async () => {
    const mocked = client();
    const baseProps = {
      client: mocked.value,
      connected: true,
      connecting: false,
      authGeneration: 1,
      overview,
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    const view = render(
      <MyServersTab {...baseProps} currentUser={{ user_id: 'alice', role: 'member' } as never} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const remove = await screen.findByRole('button', { name: 'Remove GitHub server' });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toHaveClass('ant-popover-open'));

    view.rerender(
      <MyServersTab
        {...baseProps}
        authGeneration={2}
        currentUser={{ user_id: 'alice', role: 'viewer' } as never}
      />
    );
    await waitFor(() => expect(remove).not.toHaveClass('ant-popover-open'));
  });
});
