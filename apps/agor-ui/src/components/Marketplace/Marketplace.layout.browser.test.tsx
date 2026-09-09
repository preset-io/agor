/**
 * Real-Chromium Catalog layout smoke.
 *
 * Component tests pin the responsive props and scroll contracts. These checks
 * cover the browser result at the desktop, phone, and short-landscape viewports
 * configured in `vitest.browser.config.ts`, without screenshot pixel churn.
 */
import type { MCPCatalogEntry, MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MCPServerCapabilityContext, POLICY_LOADING_HINT } from '../MCPServer/memberPolicy';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';
import { CatalogTab } from './CatalogTab';
import { CredentialsTab } from './CredentialsTab';
import { MyServersTab } from './MyServersTab';
import {
  MARKETPLACE_CATALOG_DRAWER_WIDTH,
  MARKETPLACE_SERVER_DRAWER_WIDTH,
} from './marketplaceLayout';
import { SessionsTab } from './SessionsTab';

const CATALOG_ENTRY: MCPCatalogEntry = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  description: 'Repository answers',
  transport: 'streamable-http',
  remote_url: 'https://mcp.deepwiki.com/mcp',
  has_remote: true,
  category: 'dev-tools',
  capabilities: ['docs', 'code-search'],
  benefit: 'Ask questions about any public GitHub repository.',
  starter_prompt: 'Explain this repository.',
  permission_disclosure: 'Reads public repositories.',
  auth_type: 'none',
};

const USER = {
  user_id: 'user-admin',
  email: 'admin@agor.live',
  role: 'admin',
} as User;

const ALLOWED: MCPServerCapabilityContext = {
  connectionReady: true,
  role: 'admin',
  isAdmin: true,
  policy: 'allow_crud',
  userId: USER.user_id,
  canConfigure: true,
};

function expectReachableInViewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(-1);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  expect(element.contains(hit) || hit === element).toBe(true);
}

function catalogClient(): AgorClient {
  const eventService = { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
  return {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn((name: string) => {
      if (name === 'mcp-catalog') {
        return {
          find: vi.fn(async () => ({
            total: 4,
            limit: 4,
            skip: 0,
            data: Array.from({ length: 4 }, (_, index) => ({
              ...CATALOG_ENTRY,
              name: `${CATALOG_ENTRY.name}-${index}`,
              title: `DeepWiki ${index + 1}`,
            })),
          })),
        };
      }
      if (name === 'mcp-member-policy') {
        return { find: vi.fn(async () => ({ policy: 'allow_crud', can_configure: true })) };
      }
      if (name === 'branches') {
        return {
          findAll: vi.fn(async () => [{ branch_id: 'branch-1', name: 'Marketplace QA' }]),
        };
      }
      if (name === 'mcp-catalog/readiness') {
        return {
          get: vi.fn(async (catalogKey: string) => ({
            catalog_key: catalogKey,
            state: 'no_auth',
          })),
        };
      }
      if (name === 'mcp-servers') return eventService;
      throw new Error(`Unexpected service ${name}`);
    }),
  } as unknown as AgorClient;
}

function renderCatalog() {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter>
        <CatalogTab
          client={catalogClient()}
          connected
          connecting={false}
          authGeneration={1}
          currentUser={USER}
        />
      </MemoryRouter>
    </ConfigProvider>
  );
}

afterEach(() => cleanup());

describe('Catalog responsive layout (real browser)', () => {
  it('keeps a tool switch focused while its local mutation is pending', async () => {
    let resolveMutation!: (value: unknown) => void;
    const mutation = new Promise((resolve) => {
      resolveMutation = resolve;
    });
    const createToolPermission = vi.fn(() => mutation);
    const service = vi.fn((path: string) => {
      if (path === 'mcp-member-policy') {
        return { find: vi.fn(async () => ({ policy: 'allow_crud', can_configure: true })) };
      }
      if (path === 'mcp-marketplace/tool-permission') return { create: createToolPermission };
      return { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
    });
    const timestamp = new Date().toISOString();
    render(
      <MyServersTab
        client={{ service } as unknown as AgorClient}
        connected
        connecting={false}
        authGeneration={1}
        currentUser={USER}
        overview={
          {
            servers: [
              {
                mcp_server_id: 'server-focus',
                name: 'focus-server',
                source: 'user',
                transport: 'http',
                enabled: true,
                tools: [
                  { name: 'read', description: 'Read data', permission: 'default' },
                  { name: 'write', description: 'Write data', permission: 'default' },
                ],
                capabilities_discovered_at: timestamp,
                session_count: 0,
                created_at: timestamp,
                updated_at: timestamp,
              },
            ],
            attachments: [],
            credentials: [],
            generated_at: timestamp,
          } as unknown as MCPMarketplaceOverview
        }
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Settings for focus-server' }));
    const control = await screen.findByRole('switch', { name: 'focus-server: read on' });
    const sibling = screen.getByRole('switch', { name: 'focus-server: write on' });
    await waitFor(() => expect(control).toBeEnabled());
    control.focus();
    fireEvent.click(control);

    expect(control).not.toBeDisabled();
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).toHaveAttribute('aria-busy', 'true');
    expect(sibling).not.toBeDisabled();
    expect(sibling).toHaveAttribute('aria-disabled', 'true');
    sibling.focus();
    fireEvent.click(sibling);
    expect(createToolPermission).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveMutation({
        mcp_server_id: 'server-focus',
        tool_name: 'read',
        permission: 'deny',
      });
      await mutation;
    });
    await waitFor(() => expect(control).toHaveAttribute('aria-busy', 'false'));
    expect(sibling).toHaveFocus();
    expect(sibling).toHaveAttribute('aria-disabled', 'false');
  });

  it('focuses Open session after Connect is replaced by success', async () => {
    const SuccessHarness = () => {
      const [success, setSuccess] = useState<{
        sessionId: string;
        authentication: 'ready';
        reusedExistingServer: false;
      } | null>(null);
      return (
        <CatalogDetailDrawer
          identityKey={USER.user_id}
          entry={CATALOG_ENTRY}
          open
          onClose={vi.fn()}
          branches={[{ branch_id: 'branch-1', name: 'Catalog QA' }] as never}
          branchesLoading={false}
          branchesError={null}
          defaultBranchId="branch-1"
          connecting={false}
          connectError={null}
          readiness={{ catalog_key: CATALOG_ENTRY.name, state: 'no_auth' }}
          connectCapability={ALLOWED}
          policyPending={false}
          policyPendingHint={POLICY_LOADING_HINT}
          success={success as never}
          onConnect={() =>
            setSuccess({
              sessionId: 'session-1',
              authentication: 'ready',
              reusedExistingServer: false,
            })
          }
        />
      );
    };
    render(<SuccessHarness />);
    fireEvent.click(screen.getByRole('checkbox'));
    const connect = screen.getByRole('button', { name: /Check & connect$/ });
    connect.focus();
    fireEvent.click(connect);

    const nextStep = await screen.findByRole('button', { name: 'Open session' });
    await waitFor(() => expect(nextStep).toHaveFocus());
  });

  it('lays out the catalog at its configured breakpoint and constrains the drawer', async () => {
    renderCatalog();
    const card = await screen.findByLabelText('Open DeepWiki 1');
    const column = card.closest('.ant-col') as HTMLElement | null;
    const row = column?.parentElement as HTMLElement | null;
    expect(column && row, 'catalog row and column should render').toBeTruthy();
    if (!column || !row) return;

    const expectedFraction = window.innerWidth < 576 ? 1 : window.innerWidth < 992 ? 1 / 2 : 1 / 3;
    expect(column.getBoundingClientRect().width / row.getBoundingClientRect().width).toBeCloseTo(
      expectedFraction,
      1
    );

    const status = screen.getAllByText('Catalog says no account')[0];
    const tooltipTrigger = status.closest('.ant-space') as HTMLElement;
    await act(async () => {
      fireEvent.mouseEnter(tooltipTrigger);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });
    await waitFor(() => {
      const visibleTooltip = Array.from(document.querySelectorAll('[role="tooltip"]')).find(
        (tooltip) => tooltip.getBoundingClientRect().width > 0
      );
      expect(visibleTooltip).toHaveTextContent(
        'Catalog metadata says this server needs no account. Agor checks the live endpoint before connecting.'
      );
    });
    await act(async () => {
      fireEvent.mouseLeave(tooltipTrigger);
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    fireEvent.click(card);
    await screen.findByText('What this can access');
    const wrapper = document.querySelector('.ant-drawer-content-wrapper') as HTMLElement | null;
    expect(wrapper, 'drawer wrapper should render').toBeTruthy();
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    expect(rect.width).toBeCloseTo(
      Math.min(MARKETPLACE_CATALOG_DRAWER_WIDTH, window.innerWidth),
      0
    );
    expect(rect.left).toBeGreaterThanOrEqual(-1);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
  });

  it('uses two session-card columns only on wide screens', () => {
    const sessionOverview = {
      servers: [],
      credentials: [],
      attachments: [
        {
          session_id: 'session-1',
          mcp_server_id: 'server-1',
          enabled: true,
          added_at: '2026-08-21T12:34:56.000Z',
          session_title: 'First session',
          session_status: 'idle',
          agentic_tool: 'claude-code',
          branch_id: 'branch-1',
          branch_name: 'main',
        },
        {
          session_id: 'session-2',
          mcp_server_id: 'server-2',
          enabled: true,
          added_at: '2026-08-21T12:34:56.000Z',
          session_title: 'Second session',
          session_status: 'idle',
          agentic_tool: 'claude-code',
          branch_id: 'branch-1',
          branch_name: 'main',
        },
      ],
      generated_at: '2026-08-21T12:34:56.000Z',
    } as unknown as MCPMarketplaceOverview;
    render(
      <MemoryRouter>
        <SessionsTab
          client={null}
          authorityKey={null}
          overview={sessionOverview}
          loading={false}
          error={null}
          refresh={vi.fn(async () => undefined)}
        />
      </MemoryRouter>
    );

    const card = screen.getByText('First session').closest('.ant-card') as HTMLElement | null;
    const column = card?.parentElement as HTMLElement | null;
    const row = column?.parentElement as HTMLElement | null;
    expect(column && row).toBeTruthy();
    if (!column || !row) return;
    const expectedFraction = window.innerWidth >= 992 ? 1 / 2 : 1;
    expect(column.getBoundingClientRect().width / row.getBoundingClientRect().width).toBeCloseTo(
      expectedFraction,
      1
    );
  });

  it('keeps the primary Credentials action directly reachable on a phone', async () => {
    if (window.innerWidth > 480) return;
    const timestamp = '2026-08-21T12:34:56.000Z';
    render(
      <CredentialsTab
        overview={
          {
            servers: [],
            attachments: [],
            credentials: [
              {
                mcp_server_id: 'server-1',
                server_name: 'A deliberately long server name for narrow viewport QA',
                method: 'oauth',
                status: 'active',
                expires_at: timestamp,
                created_at: timestamp,
                updated_at: timestamp,
              },
            ],
            generated_at: timestamp,
          } as unknown as MCPMarketplaceOverview
        }
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
        canManageCredentials
        onOpenServerSettings={vi.fn()}
      />
    );

    const manage = screen.getByRole('button', { name: /OAuth connection/ });
    expect(document.querySelector('.ant-table-content')).toBeNull();
    expectReachableInViewport(manage);
  });

  it('keeps the primary My Servers action directly reachable on a phone', async () => {
    if (window.innerWidth > 480) return;
    const overview = {
      servers: [
        {
          mcp_server_id: 'server-1',
          name: 'long-server',
          display_name: 'A deliberately long server display name',
          source: 'user',
          transport: 'http',
          enabled: true,
          tools: [],
          session_count: 0,
          created_at: '2026-08-21T12:34:56.000Z',
          updated_at: '2026-08-21T12:34:56.000Z',
        },
      ],
      attachments: [],
      credentials: [],
      generated_at: '2026-08-21T12:34:56.000Z',
    } as unknown as MCPMarketplaceOverview;
    render(
      <MyServersTab
        client={null}
        connected={false}
        connecting={false}
        authGeneration={0}
        currentUser={null}
        overview={overview}
        loading={false}
        error={null}
        refresh={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByText('A deliberately long server display name')).toBeVisible();
    const settings = screen.getByRole('button', {
      name: 'Settings for A deliberately long server display name',
    });
    expect(settings).toBeVisible();
    expect(document.querySelector('.ant-table-content')).toBeNull();
    expectReachableInViewport(settings);

    fireEvent.click(settings);
    await screen.findByText('Server settings');
    const wrapper = document.querySelector('.ant-drawer-content-wrapper') as HTMLElement | null;
    expect(wrapper, 'server settings drawer should render').toBeTruthy();
    if (!wrapper) return;
    expect(wrapper.getBoundingClientRect().width).toBeCloseTo(
      Math.min(MARKETPLACE_SERVER_DRAWER_WIDTH, window.innerWidth),
      0
    );
  });
});
