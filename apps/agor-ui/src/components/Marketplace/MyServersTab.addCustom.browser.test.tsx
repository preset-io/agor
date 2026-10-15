import type { MCPMarketplaceOverview, MCPMarketplaceServer, MCPServerID } from '@agor/core/types';
import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { checkBrowserSanity } from '../../test/browserSanity';
import { MyServersTab } from './MyServersTab';

checkBrowserSanity();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(cleanup);

const emptyOverview: MCPMarketplaceOverview = {
  servers: [],
  attachments: [],
  credentials: [],
  generated_at: new Date(0).toISOString(),
};

const existing: MCPMarketplaceServer = {
  mcp_server_id: '01900000-0000-7000-8000-0000000000a1' as MCPServerID,
  name: 'existing',
  display_name: 'Existing',
  source: 'user',
  transport: 'http',
  enabled: true,
  tools: [],
  capabilities_discovered_at: new Date().toISOString(),
  session_count: 0,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

function fixture(canConfigure = true) {
  const created: MCPServer[] = [];
  const create = vi.fn(async (data: Record<string, unknown>) => {
    const server = {
      ...data,
      mcp_server_id: '01900000-0000-7000-8000-0000000000b2',
      source: 'user',
      config_version: 1,
    } as unknown as MCPServer;
    created.push(server);
    return server;
  });
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: (path: string) => {
      if (path === 'mcp-member-policy')
        return { find: async () => ({ policy: 'allow_crud', can_configure: canConfigure }) };
      if (path === 'mcp-servers/discover')
        return { create: async () => ({ success: true, tools: [] }) };
      return { create, get: async () => created[0], on: vi.fn(), removeListener: vi.fn() };
    },
  } as unknown as AgorClient;
  return { client, create, created };
}

function Harness({
  client,
  created,
  initial,
}: {
  client: AgorClient;
  created: MCPServer[];
  initial: MCPMarketplaceOverview;
}) {
  const [overview, setOverview] = useState(initial);
  // The daemon's overview lists a server once it exists; mirror that on refresh.
  const refresh = async () =>
    setOverview((current) => ({
      ...current,
      servers: [
        ...initial.servers,
        ...created.map((server) => ({
          ...existing,
          mcp_server_id: server.mcp_server_id as MCPServerID,
          name: server.name,
          display_name: server.display_name,
          source: 'user' as const,
        })),
      ],
    }));
  return (
    <MyServersTab
      client={client}
      connected
      connecting={false}
      authGeneration={1}
      currentUser={{ user_id: 'member-a', role: 'member' } as never}
      overview={overview}
      loading={false}
      error={null}
      refresh={refresh}
      onBrowseCatalog={() => undefined}
    />
  );
}

function mount(initial: MCPMarketplaceOverview, canConfigure = true) {
  const value = fixture(canConfigure);
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <Harness client={value.client} created={value.created} initial={initial} />
      </App>
    </ConfigProvider>
  );
  return value;
}

async function fillHttpBearer(dialog: HTMLElement) {
  await act(() => userEvent.fill(within(dialog).getByLabelText('Name (Internal ID)'), 'acme'));
  await act(() => userEvent.fill(within(dialog).getByLabelText('Display Name (Optional)'), 'Acme'));
  expect(within(dialog).getByText('HTTP')).toBeVisible();
  await act(() =>
    userEvent.fill(within(dialog).getByLabelText('URL'), 'https://mcp.example.com/mcp')
  );
  const authType = within(dialog).getByLabelText('Auth Type').closest('.ant-select');
  if (!(authType instanceof HTMLElement)) throw new Error('Auth Type select not found');
  await act(() => userEvent.click(authType));
  // AntD's role=option nodes are an offscreen a11y list; click the visible item.
  const bearer = await screen.findByText('Bearer Token', {
    selector: '.ant-select-item-option-content',
  });
  await act(() => userEvent.click(bearer));
  await act(() => userEvent.fill(within(dialog).getByLabelText('Token'), 'fictional-token'));
}

it('adds a custom HTTP server from the empty state and opens it', async () => {
  const { create } = mount(emptyOverview);
  const add = await screen.findByRole('button', { name: /Add custom server/ });
  expect(screen.getByRole('button', { name: 'Browse catalog' })).toBeVisible();
  await act(() => userEvent.click(add));
  const dialog = await screen.findByRole('dialog', { name: 'Add MCP Server' });
  await fillHttpBearer(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());
  await act(() => userEvent.click(save));

  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    owner_user_id: 'member-a',
    name: 'acme',
    display_name: 'Acme',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    auth: { type: 'bearer', token: 'fictional-token' },
  });
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Add MCP Server' })).not.toBeInTheDocument()
  );
  // The new server is listed as Manual and its settings drawer opens.
  expect(await screen.findByLabelText('Remove Acme server')).toBeInTheDocument();
  expect(screen.getAllByText('Manual').length).toBeGreaterThan(0);
});

it('opens from the toolbar and resets the draft after cancel', async () => {
  const { create } = mount({ ...emptyOverview, servers: [existing] });
  const add = await screen.findByRole('button', { name: /Add custom server/ });
  await act(() => userEvent.click(add));
  let dialog = await screen.findByRole('dialog', { name: 'Add MCP Server' });
  await fillHttpBearer(dialog);
  await act(() => userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Add MCP Server' })).not.toBeInTheDocument()
  );

  await act(() => userEvent.click(screen.getByRole('button', { name: /Add custom server/ })));
  dialog = await screen.findByRole('dialog', { name: 'Add MCP Server' });
  expect(within(dialog).getByLabelText('Name (Internal ID)')).toHaveValue('');
  expect(within(dialog).getByLabelText('URL')).toHaveValue('');
  expect(within(dialog).queryByLabelText('Token')).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});

it('keeps a failed create visible in the form', async () => {
  const { create } = mount(emptyOverview);
  create.mockRejectedValueOnce(new Error('fictional-create-error'));
  const add = await screen.findByRole('button', { name: /Add custom server/ });
  await act(() => userEvent.click(add));
  const dialog = await screen.findByRole('dialog', { name: 'Add MCP Server' });
  await fillHttpBearer(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());
  await act(() => userEvent.click(save));
  expect(await within(dialog).findByText(/add the MCP server/)).toBeVisible();
  expect(within(dialog).getByLabelText('URL')).toHaveValue('https://mcp.example.com/mcp');
});

it('does not offer custom servers to a member who cannot configure', async () => {
  mount({ ...emptyOverview, servers: [existing] }, false);
  expect(
    await screen.findByText("Your workspace's MCP policy doesn't let you change this server.")
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: /Add custom server/ })).not.toBeInTheDocument();
});

it('does not offer custom servers from the empty state without configure permission', async () => {
  mount(emptyOverview, false);
  await screen.findByRole('button', { name: 'Browse catalog' });
  // Let the member-policy answer settle before asserting absence.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole('button', { name: /Add custom server/ })).not.toBeInTheDocument();
});
