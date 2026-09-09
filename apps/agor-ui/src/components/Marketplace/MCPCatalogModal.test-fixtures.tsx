import type {
  MCPCatalogEntry,
  MCPMarketplaceOverview,
  MCPServerID,
  SessionID,
} from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { App, ConfigProvider } from 'antd';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { MCPCatalogModalProvider } from '../../contexts/MCPCatalogModalContext';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { AppHeader } from '../AppHeader';
import { SessionMcpFooterControl } from '../SessionPanel/SessionMcpFooterControl';
import { MCPCatalogModalHost } from './MCPCatalogModalHost';

export const catalogUser = {
  user_id: 'alice',
  email: 'alice@example.test',
  role: 'member',
} as User;
export const catalogEntry: MCPCatalogEntry = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  description: 'Repository answers',
  transport: 'streamable-http',
  remote_url: 'https://mcp.deepwiki.com/mcp',
  has_remote: true,
  category: 'dev-tools',
  capabilities: ['docs'],
  benefit: 'Ask questions about a public repository.',
  starter_prompt: 'Explain this repository.',
  permission_disclosure: 'Reads public repositories.',
  auth_type: 'none',
};
export const catalogOverview: MCPMarketplaceOverview = {
  servers: [
    {
      mcp_server_id: 'server-1' as MCPServerID,
      name: 'deepwiki',
      display_name: 'Saved DeepWiki',
      source: 'catalog',
      transport: 'http',
      enabled: true,
      tools: [],
      session_count: 1,
      created_at: '2026-09-08T00:00:00.000Z',
      updated_at: '2026-09-08T00:00:00.000Z',
    },
  ],
  credentials: [
    {
      mcp_server_id: 'server-1' as MCPServerID,
      server_name: 'deepwiki',
      server_display_name: 'Saved DeepWiki',
      method: 'oauth',
      status: 'active',
    },
  ],
  attachments: [
    {
      session_id: '01900000-0000-7000-8000-000000000001' as SessionID,
      mcp_server_id: 'server-1' as MCPServerID,
      enabled: true,
      added_at: '2026-09-08T00:00:00.000Z',
      session_title: 'Catalog destination',
      session_status: 'idle',
      agentic_tool: 'claude-code',
      branch_id: 'branch-1',
      branch_name: 'main',
    },
  ],
  generated_at: '2026-09-08T00:00:00.000Z',
};

export function makeCatalogClient() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const events = (path: string) => ({
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const key = `${path}:${event}`;
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(`${path}:${event}`)?.delete(listener);
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(`${path}:${event}`)?.delete(listener);
    }),
  });
  const overviewRead = vi.fn(async () => catalogOverview);
  const connect = vi.fn(async () => ({
    session: {
      session_id: catalogOverview.attachments[0].session_id,
      title: 'Catalog destination',
    },
    mcp_server: { ...catalogOverview.servers[0], auth: { type: 'none' } },
    starter_prompt: catalogEntry.starter_prompt,
  }));
  const services = new Map<string, object>();
  const service = (name: string) => {
    if (!services.has(name))
      services.set(name, {
        ...events(name),
        find:
          name === 'mcp-marketplace'
            ? overviewRead
            : vi.fn(async () =>
                name === 'mcp-catalog'
                  ? { data: [catalogEntry], total: 1, limit: 1, skip: 0 }
                  : name === 'mcp-member-policy'
                    ? { policy: 'allow_crud', can_configure: true }
                    : []
              ),
        findAll: vi.fn(async () => [{ branch_id: 'branch-1', name: 'Catalog QA' }]),
        get: vi.fn(async () => ({ catalog_key: catalogEntry.name, state: 'no_auth' })),
        create: name === 'mcp-catalog/connect' ? connect : vi.fn(async () => ({ success: true })),
        remove: vi.fn(),
      });
    return services.get(name);
  };
  return {
    client: { service, io: events('socket') } as unknown as AgorClient,
    overviewRead,
    connect,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    emit: (key: string) => {
      for (const callback of listeners.get(key) ?? []) callback();
    },
  };
}

function Location() {
  return <output data-testid="route">{useLocation().pathname}</output>;
}

/** Real header, picker, controller, lazy host and four tabs; only the API boundary is fake. */
export function CatalogHarness({
  client,
  user = catalogUser,
  path = '/',
}: {
  client: AgorClient;
  user?: User;
  path?: string;
}) {
  return (
    <ThemeProvider>
      <ConfigProvider>
        <App>
          <MemoryRouter initialEntries={[path]}>
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
              <MCPCatalogModalProvider key={user.user_id}>
                <AppHeader user={user} />
                <div style={{ position: 'fixed', bottom: 10, left: 10 }}>
                  <SessionMcpFooterControl
                    client={client}
                    currentUserId={user.user_id}
                    sessionId="current-session"
                    sessionMcpServerIds={[]}
                    mcpServerById={new Map()}
                    userAuthenticatedMcpServerIds={new Set()}
                  />
                </div>
                <MCPCatalogModalHost
                  client={client}
                  connected
                  connecting={false}
                  authGeneration={1}
                  currentUser={user}
                />
                <Location />
              </MCPCatalogModalProvider>
            </ConnectionProvider>
          </MemoryRouter>
        </App>
      </ConfigProvider>
    </ThemeProvider>
  );
}
