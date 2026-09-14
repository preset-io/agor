/**
 * Real-Chromium coverage for the MCP table inside the actual Settings shell.
 * The shell removes the navigation rail and content padding from the modal,
 * so a standalone full-width table does not reproduce this layout contract.
 */
import type { AgorClient, MCPServer, User } from '@agor-live/client';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { SettingsModal } from './SettingsModal';

const ADMIN = {
  user_id: 'layout-admin',
  email: 'layout-admin@agor.live',
  name: 'Alexandria Layout Administrator With A Long Name',
  role: 'admin',
} as User;

const SERVER = {
  mcp_server_id: 'layout-server',
  name: 'a-very-long-canonical-mcp-server-name-that-must-not-set-the-column-width',
  display_name: 'A very long MCP server display name that needs truncation',
  description: 'Layout fixture',
  transport: 'http',
  url: 'https://mcp.example.com/a/path/that/is/deliberately/far/too/long/for/the/settings-modal',
  scope: 'global',
  source: 'a-deliberately-long-provider-source',
  owner_user_id: ADMIN.user_id,
  enabled: true,
  tools: [{ name: 'search', description: 'Search' }],
  created_at: '2026-01-01T00:00:00.000Z',
} as MCPServer;

const eventService = { on: vi.fn(), removeListener: vi.fn() };
const client = {
  io: { on: vi.fn(), off: vi.fn() },
  service: vi.fn((name: string) => {
    if (name === 'mcp-member-policy') {
      return {
        find: vi.fn(async () => ({ policy: 'allow_crud', can_configure: true })),
        patch: vi.fn(),
      };
    }
    if (name === 'mcp-servers') return eventService;
    return {};
  }),
} as unknown as AgorClient;

function renderSettings() {
  agorStore.setState({
    mcpServerById: new Map([[SERVER.mcp_server_id, SERVER]]),
    userById: new Map([[ADMIN.user_id, ADMIN]]),
  });

  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AntdApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            authGeneration: 1,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SettingsModal
            open
            activeTab="mcp"
            currentUser={ADMIN}
            client={client}
            onClose={vi.fn()}
          />
        </ConnectionProvider>
      </AntdApp>
    </ConfigProvider>
  );
}

function expectInside(container: HTMLElement, element: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  expect(elementRect.left).toBeGreaterThanOrEqual(containerRect.left - 1);
  expect(elementRect.right).toBeLessThanOrEqual(containerRect.right + 1);
}

async function expectTableFits() {
  await waitFor(() => expect(screen.getByText('New MCP Server').closest('button')).toBeEnabled());

  const row = screen.getByText(SERVER.display_name as string).closest('tr');
  expect(row).toBeTruthy();
  if (!row) return;
  const table = row.closest('table');
  expect(table).toBeTruthy();
  if (!table) return;
  const tableViewport = table.closest('.ant-table-content') as HTMLElement | null;
  expect(tableViewport).toBeTruthy();
  if (!tableViewport) return;

  const actions = within(table).getByRole('columnheader', { name: 'Actions' });
  const view = within(row).getByRole('button', { name: 'View details' });
  const edit = within(row).getByRole('button', { name: 'Edit' });
  const remove = within(row).getByRole('button', { name: 'Delete' });
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((header) => header.textContent);

  expect(table.style.tableLayout).toBe('fixed');
  expect(headers).toEqual(
    window.innerWidth >= 1200
      ? ['Name', 'Transport', 'Scope', 'Status', 'Health', 'Owner', 'Source', 'Actions']
      : ['Server', 'Actions']
  );
  expect(tableViewport.scrollWidth).toBeLessThanOrEqual(tableViewport.clientWidth + 1);
  expectInside(tableViewport, actions);
  expectInside(tableViewport, view);
  expectInside(tableViewport, edit);
  expectInside(tableViewport, remove);
  await waitFor(() => expect(view).toBeVisible());
  expect(edit).toBeVisible();
  expect(remove).toBeVisible();
  expect(row).toHaveTextContent('HTTP');
  expect(row).toHaveTextContent('global');
  expect(row).toHaveTextContent('Enabled');
  expect(row).toHaveTextContent('1 tools');
  expect(row).toHaveTextContent(ADMIN.name as string);
  expect(row).toHaveTextContent(SERVER.source as string);

  view.focus();
  expect(view).toHaveFocus();
}

beforeEach(() => agorStore.getState().reset());
afterEach(() => {
  cleanup();
  agorStore.getState().reset();
});

describe('MCP Servers Settings table layout (real browser)', () => {
  it('keeps the table and its complete action group inside the modal at every supported viewport', async () => {
    renderSettings();
    await expectTableFits();
  });
});
