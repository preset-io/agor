import type { AgorClient, MCPServer } from '@agor-live/client';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { agorStore } from '../../store/agorStore';
import { SessionMcpFooterControl } from './SessionMcpFooterControl';

const setMcpServerHidden = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('@/hooks/usePermissions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePermissions: () => ({ isAdmin: false, role: 'member', hasRole: () => true }),
}));
vi.mock('@/contexts/ConnectionContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConnectionState: () => ({ connected: true, connecting: false, authGeneration: 1 }),
}));
vi.mock('../../utils/userPreferences', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setMcpServerHidden,
}));

// The panel opens above its footer trigger, so leave room for it.
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ConfigProvider>
    <App>
      <div style={{ paddingTop: 480 }}>{children}</div>
    </App>
  </ConfigProvider>
);

const globalServer = (id: string, name: string, auth: MCPServer['auth']) =>
  ({
    mcp_server_id: id,
    name,
    display_name: name,
    transport: 'http',
    url: `https://${id}.example.test/mcp`,
    scope: 'global',
    enabled: true,
    auth,
  }) as MCPServer;

const docs = globalServer('docs', 'Docs', { type: 'none' });
const tracker = globalServer('tracker', 'Tracker', { type: 'oauth', oauth_mode: 'per_user' });
const wiki = globalServer('wiki', 'Wiki', { type: 'oauth', oauth_mode: 'per_user' });

const find = vi.fn();
const patch = vi.fn(async () => ({}));
const client = {
  service: () => ({ find, patch, create: vi.fn(), remove: vi.fn() }),
  io: { on: vi.fn(), off: vi.fn() },
} as unknown as AgorClient;

beforeEach(() => {
  vi.clearAllMocks();
  agorStore.getState().reset();
  agorStore.getState().markSessionMcpLoaded('session-id');
  find.mockImplementation(async ({ query }: { query: Record<string, unknown> }) =>
    query.effective
      ? {
          entries: [
            { mcp_server_id: 'docs', source: 'global', state: 'active', server: docs },
            { mcp_server_id: 'tracker', source: 'global', state: 'needs_connect', server: tracker },
            { mcp_server_id: 'wiki', source: 'global', state: 'hidden', server: wiki },
          ],
        }
      : []
  );
});
afterEach(cleanup);

function renderPill() {
  return render(
    <SessionMcpFooterControl
      client={client}
      currentUserId="user-a"
      sessionId="session-id"
      sessionMcpServerIds={[]}
      mcpServerById={new Map([docs, tracker, wiki].map((server) => [server.mcp_server_id, server]))}
      userAuthenticatedMcpServerIds={new Set()}
    />,
    { wrapper: Wrapper }
  );
}

it('counts active global servers and offers unconnected ones as connect rows', async () => {
  renderPill();
  const trigger = screen.getByRole('button', { name: /^MCP servers\./ });
  // Compact on phones (`+1`), spelled out elsewhere.
  await waitFor(() => expect(trigger).toHaveTextContent(/^MCP1(· 1 to connect|\+1)$/));
  expect(trigger).toHaveAccessibleName(/1 more available to connect/);

  await userEvent.click(trigger);
  const rows = await screen.findByTestId('session-mcp-global-servers');
  const active = within(rows).getByText('Docs').closest('[data-mcp-entry-state]');
  const toConnect = within(rows).getByText('Tracker').closest('[data-mcp-entry-state]');
  expect(active).toHaveAttribute('data-mcp-entry-state', 'active');
  expect(toConnect).toHaveAttribute('data-mcp-entry-state', 'needs_connect');
  // Hidden servers stay out of the rows until asked for.
  expect(within(rows).queryByText('Wiki')).toBeNull();

  await userEvent.click(within(rows).getByRole('button', { name: 'Hide Tracker' }));
  await waitFor(() =>
    expect(setMcpServerHidden).toHaveBeenCalledWith(client, 'user-a', 'tracker', true)
  );

  await userEvent.click(screen.getByRole('button', { name: 'Show hidden (1)' }));
  await userEvent.click(screen.getByRole('button', { name: 'Unhide Wiki' }));
  await waitFor(() =>
    expect(setMcpServerHidden).toHaveBeenCalledWith(client, 'user-a', 'wiki', false)
  );
});

it('switches a global server off for just this session', async () => {
  renderPill();
  // The accessible name changes once the effective view loads; click after that.
  const trigger = await screen.findByRole('button', { name: /available to connect/ });
  await userEvent.click(trigger);
  const toggle = await screen.findByRole('switch', { name: 'Use Docs in this session' });
  expect(toggle).toBeChecked();
  await userEvent.click(toggle);
  await waitFor(() => expect(patch).toHaveBeenCalledWith('docs', { enabled: false }));
  // The view is re-read from the daemon after the switch.
  await waitFor(() =>
    expect(find.mock.calls.filter(([params]) => params.query.effective)).toHaveLength(2)
  );
});

it('switches a linked global server off when it is deselected', async () => {
  // A global server switched back on in this session is an enabled link, so it
  // also shows in the attach picker. Deselecting it must not re-inherit it.
  agorStore.setState({ mcpServerById: new Map([[docs.mcp_server_id, docs]]) });
  find.mockImplementation(async ({ query }: { query: Record<string, unknown> }) =>
    query.effective
      ? {
          entries: [{ mcp_server_id: 'docs', source: 'global', state: 'active', server: docs }],
        }
      : [docs]
  );
  const remove = vi.fn();
  (client as unknown as { service: () => unknown }).service = () => ({
    find,
    patch,
    remove,
    create: vi.fn(),
  });
  render(
    <SessionMcpFooterControl
      client={client}
      currentUserId="user-a"
      sessionId="session-id"
      sessionMcpServerIds={['docs']}
      mcpServerById={new Map([[docs.mcp_server_id, docs]])}
      userAuthenticatedMcpServerIds={new Set()}
    />,
    { wrapper: Wrapper }
  );
  await userEvent.click(await screen.findByRole('button', { name: /^MCP servers\. 1 MCP/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Session MCP servers' });
  const tagRemove = await waitFor(() => {
    const control = dialog.querySelector('.ant-select-selection-item-remove');
    if (!control) throw new Error('no selected tag yet');
    return control as HTMLElement;
  });
  await waitFor(() => expect(dialog.querySelector('.ant-select-disabled')).toBeNull());
  await userEvent.click(tagRemove);
  await waitFor(() => expect(patch).toHaveBeenCalledWith('docs', { enabled: false }));
  expect(remove).not.toHaveBeenCalled();
});
