import { canConfigureMCPServers } from '@agor/core/mcp/member-policy';
import type { MCPMarketplaceOverview, MCPMarketplaceServer, MCPServerID } from '@agor/core/types';
import type { AgorClient, MCPMemberPolicy, MCPServer } from '@agor-live/client';
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

type Role = 'admin' | 'member' | 'viewer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture(options: { role?: Role; policy?: MCPMemberPolicy } = {}) {
  const state = { role: options.role ?? 'member', policy: options.policy ?? 'allow_crud' };
  const created: MCPServer[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const addServer = (data: Record<string, unknown>) => {
    const server = {
      ...data,
      mcp_server_id: '01900000-0000-7000-8000-0000000000b2',
      source: 'user',
      config_version: 1,
    } as unknown as MCPServer;
    created.push(server);
    return server;
  };
  const create = vi.fn(async (data: Record<string, unknown>) => addServer(data));
  const patch = vi.fn(async (_id: string, data: { expected_config_version?: number }) => ({
    ...created[0],
    ...data,
    config_version: (data.expected_config_version ?? 1) + 1,
  }));
  const oauthStart = vi.fn(async () => ({ success: false, error: 'fictional-oauth-start-error' }));
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: (path: string) => {
      // The daemon answers `can_configure` from role and policy together.
      if (path === 'mcp-member-policy')
        return {
          find: async () => ({
            policy: state.policy,
            can_configure: canConfigureMCPServers(state.role, state.policy),
          }),
        };
      if (path === 'mcp-servers/discover')
        return { create: async () => ({ success: true, tools: [] }) };
      if (path === 'mcp-servers/test-oauth')
        return { create: async () => ({ success: true, requiresBrowserFlow: true }) };
      if (path === 'mcp-servers/oauth-start') return { create: oauthStart };
      return {
        create,
        patch,
        get: async () => created[0],
        on: (event: string, listener: () => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(listener);
        },
        removeListener: (event: string, listener: () => void) =>
          listeners.get(event)?.delete(listener),
      };
    },
  } as unknown as AgorClient;
  // A policy write elsewhere: the daemon publishes an invalidation, the tab refetches.
  const setPolicy = (policy: MCPMemberPolicy) => {
    state.policy = policy;
    for (const listener of listeners.get('member-policy:changed') ?? []) listener();
  };
  return { client, create, created, patch, oauthStart, setPolicy, state, addServer };
}

type Fixture = ReturnType<typeof fixture>;
const controls: { refresh?: () => Promise<void> } = {};

function Harness({
  client,
  created,
  initial,
  role,
}: {
  client: AgorClient;
  created: MCPServer[];
  initial: MCPMarketplaceOverview;
  role: Role;
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
  controls.refresh = refresh;
  return (
    <MyServersTab
      client={client}
      connected
      connecting={false}
      authGeneration={1}
      currentUser={{ user_id: 'member-a', role } as never}
      overview={overview}
      loading={false}
      error={null}
      refresh={refresh}
      onBrowseCatalog={() => undefined}
    />
  );
}

function mount(
  initial: MCPMarketplaceOverview,
  options: { role?: Role; policy?: MCPMemberPolicy } = {}
) {
  const value = fixture(options);
  const tree = (role: Role) => (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <Harness client={value.client} created={value.created} initial={initial} role={role} />
      </App>
    </ConfigProvider>
  );
  const { rerender } = render(tree(value.state.role));
  const setRole = (role: Role) => {
    value.state.role = role;
    rerender(tree(role));
  };
  return { ...value, setRole };
}

async function openCreateDialog() {
  // Until the policy answer lands the add action is a different, disabled button.
  const add = await waitFor(() => {
    const button = screen.getByRole('button', { name: /Add custom server/ });
    expect(button).toBeEnabled();
    return button;
  });
  await act(() => userEvent.click(add));
  return screen.findByRole('dialog', { name: 'Add MCP Server' });
}

async function chooseOption(dialog: HTMLElement, label: string, option: string) {
  const select = within(dialog).getByLabelText(label).closest('.ant-select');
  if (!(select instanceof HTMLElement)) throw new Error(`${label} select not found`);
  await act(() => userEvent.click(select));
  // AntD's role=option nodes are an offscreen a11y list; click the visible item.
  const item = await screen.findByText(option, { selector: '.ant-select-item-option-content' });
  await act(() => userEvent.click(item));
}

/** The labels a Select offers, read from its open dropdown. */
async function offeredOptions(dialog: HTMLElement, label: string): Promise<string[]> {
  const select = within(dialog).getByLabelText(label).closest('.ant-select');
  if (!(select instanceof HTMLElement)) throw new Error(`${label} select not found`);
  await act(() => userEvent.click(select));
  const dropdown = await waitFor(() => {
    const open = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    if (!(open instanceof HTMLElement)) throw new Error('dropdown not open');
    return open;
  });
  const labels = Array.from(dropdown.querySelectorAll('.ant-select-item-option-content')).map(
    (node) => node.textContent ?? ''
  );
  await act(() => userEvent.keyboard('{Escape}'));
  return labels;
}

async function fillHttp(dialog: HTMLElement) {
  await act(() => userEvent.fill(within(dialog).getByLabelText('Name (Internal ID)'), 'acme'));
  await act(() => userEvent.fill(within(dialog).getByLabelText('Display Name (Optional)'), 'Acme'));
  expect(within(dialog).getByText('HTTP')).toBeVisible();
  await act(() =>
    userEvent.fill(within(dialog).getByLabelText('URL'), 'https://mcp.example.com/mcp')
  );
}

async function fillHttpBearer(dialog: HTMLElement) {
  await fillHttp(dialog);
  await chooseOption(dialog, 'Auth Type', 'Bearer Token');
  await act(() => userEvent.fill(within(dialog).getByLabelText('Token'), 'fictional-token'));
}

/** Fill an OAuth draft and pass the auth test, which offers `Start OAuth Flow`. */
async function fillHttpOAuth(dialog: HTMLElement) {
  await fillHttp(dialog);
  await chooseOption(dialog, 'Auth Type', 'OAuth 2.1');
  await act(() =>
    userEvent.click(within(dialog).getByRole('button', { name: 'Test Authentication' }))
  );
  return within(dialog).findByRole('button', { name: 'Start OAuth Flow' });
}

async function expectAddRestriction(button: HTMLElement, text: RegExp) {
  expect(button).toBeDisabled();
  // A disabled button gets no pointer events; its tooltip host is the wrapper.
  const host = button.parentElement;
  if (!host) throw new Error('tooltip host not found');
  await act(() => userEvent.hover(host));
  expect(await screen.findByText(text)).toBeInTheDocument();
}

it('adds a custom HTTP server from the empty state and opens it', async () => {
  const { create } = mount(emptyOverview);
  expect(await screen.findByRole('button', { name: 'Browse catalog' })).toBeVisible();
  const dialog = await openCreateDialog();
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
  let dialog = await openCreateDialog();
  await fillHttpBearer(dialog);
  await act(() => userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Add MCP Server' })).not.toBeInTheDocument()
  );

  dialog = await openCreateDialog();
  expect(within(dialog).getByLabelText('Name (Internal ID)')).toHaveValue('');
  expect(within(dialog).getByLabelText('URL')).toHaveValue('');
  expect(within(dialog).queryByLabelText('Token')).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});

it('keeps a failed create visible in the form', async () => {
  const { create } = mount(emptyOverview);
  create.mockRejectedValueOnce(new Error('fictional-create-error'));
  const dialog = await openCreateDialog();
  await fillHttpBearer(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());
  await act(() => userEvent.click(save));
  expect(await within(dialog).findByText(/add the MCP server/)).toBeVisible();
  expect(within(dialog).getByLabelText('URL')).toHaveValue('https://mcp.example.com/mcp');
});

it('tells a member who cannot configure why the toolbar add is off', async () => {
  mount({ ...emptyOverview, servers: [existing] }, { policy: 'use_existing_only' });
  expect(
    await screen.findByText("Your workspace's MCP policy doesn't let you change this server.")
  ).toBeVisible();
  await expectAddRestriction(
    screen.getByRole('button', { name: /Add custom server/ }),
    /doesn't let you add servers/
  );
});

it('tells a member who cannot configure why the empty-state add is off', async () => {
  mount(emptyOverview, { policy: 'use_existing_only' });
  await screen.findByRole('button', { name: 'Browse catalog' });
  // The policy reason only replaces the pending hint once the answer has landed.
  await expectAddRestriction(
    screen.getByRole('button', { name: /Add custom server/ }),
    /doesn't let you add servers/
  );
});

it.each([
  ['member', ['HTTP', 'SSE (Server-Sent Events)']],
  ['admin', ['stdio (Local process)', 'HTTP', 'SSE (Server-Sent Events)']],
] as const)('offers a %s only the transports the daemon accepts', async (role, transports) => {
  mount(emptyOverview, { role });
  const dialog = await openCreateDialog();
  expect(await offeredOptions(dialog, 'Transport')).toEqual(transports);
});

it.each([
  ['member', false],
  ['admin', true],
] as const)(
  'under allow_private_only offers a %s shared ownership and global scope: %s',
  async (role, offered) => {
    mount(emptyOverview, { role, policy: 'allow_private_only' });
    const dialog = await openCreateDialog();
    expect(
      (await offeredOptions(dialog, 'Installation ownership')).includes('Shared (workspace)')
    ).toBe(offered);
    expect((await offeredOptions(dialog, 'Scope')).includes('Global (all eligible sessions)')).toBe(
      offered
    );
  }
);

it('blocks an already-open create dialog on demotion', async () => {
  const { create, setRole } = mount(emptyOverview);
  const dialog = await openCreateDialog();
  await fillHttp(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());

  setRole('viewer');

  await waitFor(() => expect(save).toBeDisabled());
  expect(within(dialog).getByText('MCP server changes are unavailable')).toBeVisible();
  expect(create).not.toHaveBeenCalled();
});

it('blocks an already-open create dialog on a live policy downgrade', async () => {
  const { create, setPolicy } = mount(emptyOverview);
  const dialog = await openCreateDialog();
  await fillHttp(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());

  await act(async () => setPolicy('use_existing_only'));

  await waitFor(() => expect(save).toBeDisabled());
  expect(await within(dialog).findByText(/doesn't let you add servers/)).toBeVisible();
  expect(create).not.toHaveBeenCalled();
});

it('keeps Create off after an unconfirmed create until the form changes', async () => {
  const { create } = mount(emptyOverview);
  create.mockRejectedValueOnce(new Error('socket has been disconnected'));
  const dialog = await openCreateDialog();
  await fillHttp(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());
  await act(() => userEvent.click(save));

  expect(
    await within(dialog).findByText(
      'The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to add the MCP server again.'
    )
  ).toBeVisible();
  expect(save).toBeDisabled();
  await act(() => userEvent.fill(within(dialog).getByLabelText('Name (Internal ID)'), 'acme-2'));
  await waitFor(() => expect(save).toBeEnabled());
  expect(create).toHaveBeenCalledOnce();
});

it('creates once when Create is clicked twice while the first create is in flight', async () => {
  const { create, addServer } = mount(emptyOverview);
  const reply = deferred<void>();
  create.mockImplementationOnce(async (data) => {
    await reply.promise;
    return addServer(data);
  });
  const dialog = await openCreateDialog();
  await fillHttp(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());

  await act(() => userEvent.dblClick(save));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() => expect(save).toBeDisabled());

  reply.resolve();
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Add MCP Server' })).not.toBeInTheDocument()
  );
  expect(create).toHaveBeenCalledOnce();
});

it('holds the OAuth start while Create is in flight', async () => {
  const { create, addServer, oauthStart } = mount(emptyOverview);
  const firstReply = deferred<void>();
  create.mockImplementationOnce(async (data) => {
    await firstReply.promise;
    return addServer(data);
  });
  const dialog = await openCreateDialog();
  const startOAuth = await fillHttpOAuth(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());

  // Create in flight: the OAuth start, which would create first, waits.
  await act(() => userEvent.click(save));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() => expect(startOAuth).toBeDisabled());
  firstReply.resolve();
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Add MCP Server' })).not.toBeInTheDocument()
  );
  expect(create).toHaveBeenCalledOnce();
  expect(oauthStart).not.toHaveBeenCalled();
});

it('holds Create while the OAuth start is creating the server', async () => {
  const { create, addServer, oauthStart } = mount(emptyOverview);
  const reply = deferred<void>();
  create.mockImplementationOnce(async (data) => {
    await reply.promise;
    return addServer(data);
  });
  const dialog = await openCreateDialog();
  const startOAuth = await fillHttpOAuth(dialog);
  const save = within(dialog).getByRole('button', { name: 'Create' });
  await waitFor(() => expect(save).toBeEnabled());

  await act(() => userEvent.click(startOAuth));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() => expect(save).toBeDisabled());
  reply.resolve();

  await waitFor(() =>
    expect(oauthStart).toHaveBeenCalledWith({
      mcp_server_id: '01900000-0000-7000-8000-0000000000b2',
    })
  );
  // The row exists now, so the footer saves it rather than adding another.
  expect(await within(dialog).findByRole('button', { name: 'Save' })).toBeVisible();
  expect(create).toHaveBeenCalledOnce();
});

it('keeps the OAuth-created draft open when the refreshed list replaces the empty state', async () => {
  const { create } = mount(emptyOverview);
  const dialog = await openCreateDialog();
  const startOAuth = await fillHttpOAuth(dialog);
  await act(() => userEvent.click(startOAuth));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(await within(dialog).findByText('fictional-oauth-start-error')).toBeVisible();
  // The created row turns the form into its editor, which labels the field plainly.
  await act(() => userEvent.fill(within(dialog).getByLabelText('Display Name'), 'Acme 2'));

  await act(async () => controls.refresh?.());

  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Browse catalog' })).not.toBeInTheDocument()
  );
  expect(screen.getByRole('dialog', { name: 'Add MCP Server' })).toBe(dialog);
  expect(within(dialog).getByLabelText('Name (Internal ID)')).toHaveValue('acme');
  expect(within(dialog).getByLabelText('Display Name')).toHaveValue('Acme 2');
  expect(within(dialog).getByText('fictional-oauth-start-error')).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
});

async function createWithOAuth(value: Fixture, dialog: HTMLElement) {
  const startOAuth = await fillHttpOAuth(dialog);
  await act(() => userEvent.click(startOAuth));
  await waitFor(() => expect(value.create).toHaveBeenCalledOnce());
  const save = await within(dialog).findByRole('button', { name: 'Save' });
  await waitFor(() => expect(save).toBeEnabled());
  return save;
}

function conflict(expected: number, current: number) {
  return Object.assign(
    new Error(
      `MCP server configuration changed (expected version ${expected}, current version ${current})`
    ),
    {
      name: 'Conflict',
      code: 409,
      data: {
        mcp_server_id: '01900000-0000-7000-8000-0000000000b2',
        expected_config_version: expected,
        current_config_version: current,
      },
    }
  );
}

it('keeps the edits after a lost patch reply and never replays past a conflict', async () => {
  const value = mount(emptyOverview);
  value.patch
    .mockRejectedValueOnce(new Error('socket has been disconnected'))
    .mockRejectedValueOnce(conflict(1, 2));
  const dialog = await openCreateDialog();
  const save = await createWithOAuth(value, dialog);
  await act(() => userEvent.fill(within(dialog).getByLabelText('Display Name'), 'Acme 2'));

  await act(() => userEvent.click(save));
  expect(
    await within(dialog).findByText(
      "The connection to Agor dropped before this was confirmed. If it didn't go through, try to save the MCP server again once the connection is back."
    )
  ).toBeVisible();
  expect(within(dialog).getByLabelText('Display Name')).toHaveValue('Acme 2');

  await act(() => userEvent.click(save));
  expect(
    await within(dialog).findByText(
      'This MCP server was changed somewhere else. Load the latest version before you save again.'
    )
  ).toBeVisible();
  expect(save).toBeDisabled();
  expect(within(dialog).getByLabelText('Display Name')).toHaveValue('Acme 2');
  expect(value.patch).toHaveBeenCalledTimes(2);
});

it('still shows the conflict when another writer changed the server it created', async () => {
  const value = mount(emptyOverview);
  value.patch.mockRejectedValueOnce(conflict(1, 2));
  const dialog = await openCreateDialog();
  const save = await createWithOAuth(value, dialog);

  await act(() => userEvent.click(save));
  expect(
    await within(dialog).findByText(
      'This MCP server was changed somewhere else. Load the latest version before you save again.'
    )
  ).toBeVisible();
  expect(save).toBeDisabled();
  expect(value.patch).toHaveBeenCalledOnce();
});
