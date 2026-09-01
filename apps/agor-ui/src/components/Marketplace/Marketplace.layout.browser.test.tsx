/**
 * Real-Chromium Marketplace layout smoke.
 *
 * Component tests pin the responsive props and scroll contracts. These checks
 * cover the browser result at the desktop, phone, and short-landscape viewports
 * configured in `vitest.browser.config.ts`, without screenshot pixel churn.
 */
import type { MCPCatalogEntry, MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogTab } from './CatalogTab';
import { CredentialsTab } from './CredentialsTab';
import { MyServersTab } from './MyServersTab';

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

describe('Marketplace responsive layout (real browser)', () => {
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

    const status = screen.getAllByText('No account needed')[0];
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
        'This server needs no account, so connecting it takes one step.'
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
    expect(rect.width).toBeLessThanOrEqual(Math.min(480, window.innerWidth) + 1);
    expect(rect.left).toBeGreaterThanOrEqual(-1);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
  });

  it('provides real horizontal table overflow on the phone viewport', async () => {
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
      />
    );

    const scroller = document.querySelector('.ant-table-content') as HTMLElement | null;
    expect(scroller, 'credential table scroller should render').toBeTruthy();
    if (!scroller) return;
    await waitFor(() => expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth));
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
  });

  it('wraps My Servers actions below server metadata on the phone viewport', () => {
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

    const title = screen.getByRole('heading', {
      name: 'A deliberately long server display name',
    });
    const header = title.parentElement?.parentElement as HTMLElement | null;
    const metadata = header?.children[0] as HTMLElement | undefined;
    const actions = header?.children[1] as HTMLElement | undefined;
    expect(header && metadata && actions, 'server header regions should render').toBeTruthy();
    if (!header || !metadata || !actions) return;
    expect(header).toHaveClass('ant-flex-wrap-wrap');
    expect(actions.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      metadata.getBoundingClientRect().bottom - 1
    );
    expect(actions.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
  });
});
