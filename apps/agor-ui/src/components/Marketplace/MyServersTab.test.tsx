import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      capabilities_discovered_at: new Date().toISOString(),
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
  const create = vi.fn(async (data?: Record<string, unknown>) =>
    data && typeof data.tool_name === 'string'
      ? {
          mcp_server_id: data.mcp_server_id,
          tool_name: data.tool_name,
          permission: data.enabled ? 'default' : 'deny',
        }
      : {
          success: true,
          tools: [
            { name: 'issues.create', description: 'Create an issue' },
            { name: 'issues.read', description: 'Read an issue' },
          ],
        }
  );
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

function settingsAction(serverId: string): HTMLButtonElement {
  const action = document.querySelector<HTMLButtonElement>(
    `[data-marketplace-settings-server-id="${serverId}"]`
  );
  if (!action) throw new Error(`Settings action for ${serverId} not found`);
  return action;
}

async function confirmServerRemoval(title: string): Promise<void> {
  fireEvent.click(await screen.findByLabelText(`Remove ${title} server`));
  const prompt = await screen.findByText(`Remove ${title}?`);
  let confirm: HTMLButtonElement | undefined;
  await waitFor(() => {
    const popover = prompt.closest('.ant-popover');
    confirm = Array.from(popover?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Remove'
    );
    expect(confirm).toBeDefined();
  });
  if (!confirm) throw new Error(`Removal confirmation for ${title} not found`);
  fireEvent.click(confirm);
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

  it('shows disabled separately when a stale active OAuth projection is present', async () => {
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
    expect(drawer).toHaveTextContent(/Disabling removes its saved OAuth connection/i);
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

  it('closes the settings portal when its route tab becomes inactive', async () => {
    const mocked = client();
    const props = {
      client: mocked.value,
      connected: true,
      connecting: false,
      authGeneration: 1,
      currentUser: { user_id: 'alice', role: 'member' } as never,
      overview,
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    const view = render(<MyServersTab {...props} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    await screen.findByRole('dialog');

    view.rerender(<MyServersTab {...props} active={false} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes after removing the last server and focuses the mounted empty inventory', async () => {
    const mocked = client();
    const emptyOverview = { ...overview, servers: [], credentials: [] };
    const baseProps = {
      client: mocked.value,
      connected: true,
      connecting: false,
      authGeneration: 1,
      currentUser: { user_id: 'alice', role: 'member' } as never,
      loading: false,
      error: null,
    };
    let view!: ReturnType<typeof render>;
    const refresh = vi.fn(async () => {
      view.rerender(<MyServersTab {...baseProps} overview={emptyOverview} refresh={refresh} />);
    });
    view = render(<MyServersTab {...baseProps} overview={overview} refresh={refresh} />);

    fireEvent.click(settingsAction('server-1'));
    await confirmServerRemoval('GitHub');

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText('Server settings')).not.toBeInTheDocument());
    expect(screen.getByText('No MCP servers installed')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText('Installed MCP server inventory')).toHaveFocus()
    );
  });

  it.each(['stale', 'failed'] as const)(
    'uses one bounded focus fallback after a %s removal refresh and ignores a late overview',
    async (refreshResult) => {
      const mocked = client();
      const linear = {
        ...overview.servers[0],
        mcp_server_id: 'server-2',
        name: 'linear',
        display_name: 'Linear',
      };
      const twoServers = {
        ...overview,
        servers: [overview.servers[0], linear],
        credentials: [
          ...overview.credentials,
          {
            ...overview.credentials[0],
            mcp_server_id: 'server-2',
            server_name: 'linear',
            server_display_name: 'Linear',
          },
        ],
      };
      const remaining = {
        ...twoServers,
        servers: [linear],
        credentials: twoServers.credentials.filter(
          (credential) => credential.mcp_server_id === 'server-2'
        ),
      };
      const refresh =
        refreshResult === 'failed'
          ? vi.fn(async () => {
              throw new Error('Removal refresh failed');
            })
          : vi.fn(async () => undefined);
      const props = {
        client: mocked.value,
        connected: true,
        connecting: false,
        authGeneration: 1,
        currentUser: { user_id: 'alice', role: 'member' } as never,
        loading: false,
        error: null,
        refresh,
      };
      const view = render(<MyServersTab {...props} overview={twoServers} />);

      fireEvent.click(settingsAction('server-1'));
      await confirmServerRemoval('GitHub');

      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      await waitFor(() => expect(screen.queryByText('Server settings')).not.toBeInTheDocument());
      const inventory = screen.getByLabelText('Installed MCP server inventory');
      await waitFor(() => expect(inventory).toHaveFocus());

      const survivingAction = settingsAction('server-2');
      survivingAction.focus();
      await act(async () => {
        view.rerender(<MyServersTab {...props} overview={remaining} />);
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
      expect(survivingAction).toHaveFocus();
    }
  );

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

  it('renders one deterministic drawer switch for a duplicate legacy tool identity', async () => {
    renderTab({
      ...overview,
      servers: [
        {
          ...overview.servers[0],
          tools: [
            { name: 'issues.create', description: 'First description', permission: 'default' },
            { name: 'issues.create', description: 'Conflicting duplicate', permission: 'deny' },
          ],
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).getAllByText('issues.create')).toHaveLength(1);
    expect(within(drawer).getByText('First description')).toBeVisible();
    expect(within(drawer).queryByText('Conflicting duplicate')).not.toBeInTheDocument();
    expect(
      within(drawer).getAllByRole('switch', { name: 'GitHub: issues.create on' })
    ).toHaveLength(1);
  });

  it('updates one tool locally without remounting, losing focus, or reloading the overview', async () => {
    const { service, create, refresh } = renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    const control = await screen.findByRole('switch', { name: 'GitHub: issues.create on' });
    await waitFor(() => expect(control).toBeEnabled());
    control.focus();
    fireEvent.click(control);

    const optimistic = await screen.findByRole('switch', { name: 'GitHub: issues.create off' });
    expect(optimistic).toBe(control);
    expect(optimistic).not.toBeDisabled();
    expect(screen.getByRole('dialog')).toBe(drawer);

    await waitFor(() => expect(service).toHaveBeenCalledWith('mcp-marketplace/tool-permission'));
    expect(create).toHaveBeenCalledWith({
      mcp_server_id: 'server-1',
      tool_name: 'issues.create',
      enabled: false,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(drawer);
  });

  it('rolls back a failed optimistic tool change without remounting the drawer or switch', async () => {
    const error = vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
    const mocked = renderTab();
    mocked.create.mockRejectedValueOnce(new Error('Permission write failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    const control = await screen.findByRole('switch', { name: 'GitHub: issues.create on' });
    control.focus();

    fireEvent.click(control);
    expect(await screen.findByRole('switch', { name: 'GitHub: issues.create off' })).toBe(control);

    await waitFor(() => expect(error).toHaveBeenCalledWith('Permission write failed'));
    const rolledBack = screen.getByRole('switch', { name: 'GitHub: issues.create on' });
    expect(rolledBack).toBe(control);
    expect(rolledBack).not.toBeDisabled();
    expect(rolledBack).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('dialog')).toBe(drawer);
    expect(mocked.refresh).not.toHaveBeenCalled();
  });

  it('keeps an in-flight tool override through conflicting overview snapshots', async () => {
    let resolveMutation!: (value: unknown) => void;
    const mutation = new Promise((resolve) => {
      resolveMutation = resolve;
    });
    const mocked = client();
    mocked.create.mockReturnValueOnce(mutation);
    const props = {
      client: mocked.value,
      connected: true,
      connecting: false,
      authGeneration: 1,
      currentUser: { user_id: 'alice', role: 'member' } as never,
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    const view = render(<MyServersTab {...props} overview={overview} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    const control = await screen.findByRole('switch', { name: 'GitHub: issues.create on' });
    fireEvent.click(control);
    expect(await screen.findByRole('switch', { name: 'GitHub: issues.create off' })).toBe(control);

    view.rerender(
      <MyServersTab
        {...props}
        overview={{
          ...overview,
          servers: [
            {
              ...overview.servers[0],
              tools: [{ ...overview.servers[0].tools[0], permission: 'deny' }],
            },
          ],
        }}
      />
    );
    view.rerender(<MyServersTab {...props} overview={overview} />);
    expect(screen.getByRole('switch', { name: 'GitHub: issues.create off' })).toBe(control);
    expect(screen.getByRole('dialog')).toBe(drawer);

    resolveMutation({
      mcp_server_id: 'server-1',
      tool_name: 'issues.create',
      permission: 'deny',
    });
    await waitFor(() => expect(control).toHaveAttribute('aria-busy', 'false'));
  });

  it('keeps multiple tool switches focusable while serializing permission writes with feedback', async () => {
    const info = vi.spyOn(message, 'info').mockImplementation(() => undefined as never);
    let resolveMutation!: (value: unknown) => void;
    const mutation = new Promise((resolve) => {
      resolveMutation = resolve;
    });
    const value: MCPMarketplaceOverview = {
      ...overview,
      servers: [
        {
          ...overview.servers[0],
          tools: [
            ...overview.servers[0].tools,
            { name: 'issues.read', description: 'Read an issue', permission: 'default' },
          ],
        },
      ],
    };
    const mocked = client();
    mocked.create.mockReturnValueOnce(mutation);
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
        refresh={vi.fn(async () => undefined)}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const first = await screen.findByRole('switch', { name: 'GitHub: issues.create on' });
    const second = screen.getByRole('switch', { name: 'GitHub: issues.read on' });
    await waitFor(() => expect(first).toBeEnabled());
    first.focus();
    fireEvent.click(first);

    await waitFor(() => expect(first).toHaveAttribute('aria-disabled', 'true'));
    expect(first).not.toBeDisabled();
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-disabled', 'true');
    expect(first).toHaveAttribute('aria-busy', 'true');
    expect(second).not.toBeDisabled();
    expect(second).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(second);
    expect(mocked.create).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'Wait for the current tool change to finish before changing another tool'
    );

    resolveMutation({
      mcp_server_id: 'server-1',
      tool_name: 'issues.create',
      permission: 'deny',
    });
    await waitFor(() => expect(second).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(second);
    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(2));
  });

  it('does not start a tool toggle while automatic discovery is in flight', async () => {
    const info = vi.spyOn(message, 'info').mockImplementation(() => undefined as never);
    const discovery = new Promise(() => undefined);
    const value: MCPMarketplaceOverview = {
      ...overview,
      servers: [
        {
          ...overview.servers[0],
          capabilities_discovered_at: new Date(0).toISOString(),
        },
      ],
    };
    const mocked = renderTab(value);
    mocked.create.mockReturnValueOnce(discovery);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('Discovering tools…');
    const control = within(drawer).getByRole('switch', { name: 'GitHub: issues.create on' });
    control.focus();
    expect(control).not.toBeDisabled();
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).toHaveAttribute('aria-busy', 'true');

    fireEvent.click(control);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Refresh tools' }));
    expect(mocked.create).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Wait for tool discovery to finish before changing a tool');
    expect(within(drawer).getByRole('switch', { name: 'GitHub: issues.create on' })).toBe(control);
    expect(control).toHaveFocus();
    expect(within(drawer).getByRole('button', { name: 'Refresh tools' })).toHaveClass(
      'ant-btn-loading'
    );
  });

  it('disconnects OAuth only after confirmation and refreshes the redacted overview', async () => {
    const { create, refresh } = renderTab();
    fireEvent.click(settingsAction('server-1'));
    fireEvent.click(await screen.findByLabelText('Disconnect GitHub OAuth connection'));
    expect(create).not.toHaveBeenCalled();
    const prompt = await screen.findByText('Disconnect GitHub?');
    const confirm = Array.from(
      prompt.closest('.ant-popover')?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent?.trim() === 'Disconnect');
    expect(confirm).toBeDefined();
    if (!confirm) throw new Error('OAuth disconnect confirmation not found');
    fireEvent.click(confirm);

    await waitFor(() => expect(create).toHaveBeenCalledWith({ mcp_server_id: 'server-1' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it('auto-discovers absent tools once on drawer open and keeps manual refresh available', async () => {
    let resolveDiscovery!: (value: unknown) => void;
    const discovery = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });
    const value: MCPMarketplaceOverview = {
      ...overview,
      servers: [
        {
          ...overview.servers[0],
          tools: [],
          capabilities_discovered_at: undefined,
        },
      ],
    };
    const mocked = renderTab(value);
    mocked.create.mockReturnValueOnce(discovery);

    fireEvent.click(settingsAction('server-1'));
    const discovering = await screen.findByText('Discovering tools…');
    const drawerNode = discovering.closest('[role="dialog"]');
    if (!(drawerNode instanceof HTMLElement)) throw new Error('Server settings drawer not found');
    const drawer = within(drawerNode);
    expect(discovering).toBeVisible();
    expect(mocked.create).toHaveBeenCalledOnce();
    expect(mocked.create).toHaveBeenCalledWith({ mcp_server_id: 'server-1' });

    resolveDiscovery({
      success: true,
      tools: [
        { name: 'read_wiki_contents', description: 'Read wiki pages' },
        { name: 'read_wiki_contents', description: 'Conflicting duplicate' },
        { name: 'read_wiki_structure', description: 'Read wiki structure' },
      ],
    });
    expect(await drawer.findByText('read_wiki_contents')).toBeVisible();
    expect(drawer.getAllByText('read_wiki_contents')).toHaveLength(1);
    expect(drawer.getByText('Read wiki pages')).toBeVisible();
    expect(drawer.queryByText('Conflicting duplicate')).not.toBeInTheDocument();
    expect(drawer.getAllByLabelText('GitHub: read_wiki_contents on')).toHaveLength(1);
    const refreshTools = drawer.getByText('Refresh tools').closest('button');
    expect(refreshTools).toBeEnabled();
    expect(mocked.refresh).not.toHaveBeenCalled();

    const close = drawer.getByLabelText('Close');
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByText('Server settings')).not.toBeInTheDocument());
    fireEvent.click(settingsAction('server-1'));
    await screen.findByText('Server settings');
    expect(mocked.create).toHaveBeenCalledOnce();
  });

  it('auto-refreshes stale discovered tools and shows an honest inline failure', async () => {
    const value: MCPMarketplaceOverview = {
      ...overview,
      servers: [
        {
          ...overview.servers[0],
          capabilities_discovered_at: new Date(0).toISOString(),
        },
      ],
    };
    const mocked = renderTab(value);
    mocked.create.mockResolvedValueOnce({ success: false, error: 'Provider is unavailable' });

    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Could not discover tools')).toBeVisible();
    expect(within(drawer).getByText('Provider is unavailable')).toBeVisible();
    expect(within(drawer).getByText('issues.create')).toBeVisible();
    expect(mocked.create).toHaveBeenCalledOnce();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const reopened = await screen.findByRole('dialog');
    expect(within(reopened).queryByText('Could not discover tools')).not.toBeInTheDocument();
    expect(within(reopened).queryByText('Provider is unavailable')).not.toBeInTheDocument();
  });

  it('waits for credential recovery, then auto-discovers while the drawer remains open', async () => {
    const mocked = client();
    const baseProps = {
      client: mocked.value,
      connected: true,
      connecting: false,
      authGeneration: 1,
      currentUser: { user_id: 'alice', role: 'member' } as never,
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    const unavailable: MCPMarketplaceOverview = {
      ...overview,
      servers: [{ ...overview.servers[0], tools: [], capabilities_discovered_at: undefined }],
      credentials: [{ ...overview.credentials[0], status: 'reauthentication_required' }],
    };
    const view = render(<MyServersTab {...baseProps} overview={unavailable} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(drawer).getByRole('button', { name: 'Refresh tools' })).toBeEnabled()
    );
    expect(mocked.create).not.toHaveBeenCalled();

    view.rerender(
      <MyServersTab
        {...baseProps}
        overview={{
          ...unavailable,
          credentials: [
            {
              ...overview.credentials[0],
              status: 'active',
              updated_at: new Date().toISOString(),
            },
          ],
        }}
      />
    );

    await waitFor(() => expect(mocked.create).toHaveBeenCalledWith({ mcp_server_id: 'server-1' }));
    expect(screen.getByRole('dialog')).toBe(drawer);
  });

  it('waits for canonical OAuth refresh before automatically discovering expired credentials', async () => {
    const mocked = client();
    const baseProps = {
      client: mocked.value,
      connected: true,
      connecting: false,
      authGeneration: 1,
      currentUser: { user_id: 'alice', role: 'member' } as never,
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    const refreshable: MCPMarketplaceOverview = {
      ...overview,
      servers: [{ ...overview.servers[0], tools: [], capabilities_discovered_at: undefined }],
      credentials: [
        {
          ...overview.credentials[0],
          status: 'refreshable',
          expires_at: new Date(0).toISOString(),
        },
      ],
    };
    const view = render(<MyServersTab {...baseProps} overview={refreshable} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings for GitHub' }));
    const drawer = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(drawer).getByRole('button', { name: 'Refresh tools' })).toBeEnabled()
    );
    expect(mocked.create).not.toHaveBeenCalled();

    view.rerender(
      <MyServersTab
        {...baseProps}
        overview={{
          ...refreshable,
          credentials: [
            {
              ...refreshable.credentials[0],
              status: 'active',
              updated_at: new Date().toISOString(),
            },
          ],
        }}
      />
    );

    await waitFor(() => expect(mocked.create).toHaveBeenCalledWith({ mcp_server_id: 'server-1' }));
    expect(screen.getByRole('dialog')).toBe(drawer);
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
