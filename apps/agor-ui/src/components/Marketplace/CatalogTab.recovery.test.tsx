import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type { Branch, MCPCatalogEntry, SessionID } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { consumePromptDraftSeed, getPromptDraft } from '../../utils/promptDrafts';
import { CatalogTab } from './CatalogTab';

const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const USER = {
  user_id: '019fd25a-7065-75f8-b6e6-f1963f9817d7',
  email: 'admin@agor.live',
  role: 'admin',
} as User;
const SESSION_ID = '019fd25a-7065-75f8-b6e6-f1963f9817d6' as SessionID;
const TEAMMATE = {
  branch_id: '019fd25a-7065-75f8-b6e6-f1963f981700',
  name: 'ada-branch',
  custom_context: { teammate: { kind: 'teammate', displayName: 'Ada' } },
} as unknown as Branch;
const ENTRY: MCPCatalogEntry = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  category: 'dev-tools',
  benefit: 'Ask questions about any public GitHub repository.',
  permission_disclosure: 'Reads public GitHub repository content only.',
  starter_prompt: 'Explain how authentication works in a repo I name.',
  capabilities: ['docs'],
  has_remote: true,
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
  auth_type: 'none',
};

function buildClient() {
  const catalogRead = vi.fn(async () => ({ total: 1, limit: 1, skip: 0, data: [ENTRY] }));
  const connect = vi.fn(async () => ({
    mcp_server: {
      mcp_server_id: 'server-1',
      name: 'deepwiki',
      transport: 'http',
      scope: 'session',
      source: 'catalog',
      enabled: true,
      auth: { type: 'none' },
    },
    starter_prompt: ENTRY.starter_prompt,
    reused_existing_server: false,
    reuse_kind: 'new_catalog_install',
  }));
  const startSession = vi.fn(async () => ({
    session: { session_id: SESSION_ID, branch_id: TEAMMATE.branch_id },
    starter_prompt: ENTRY.starter_prompt,
  }));
  const getPrimaryTeammate = vi.fn(async () => TEAMMATE);
  const getPrimaryTeammateCandidates = vi.fn(async () => [TEAMMATE]);
  const eventService = { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn((path: string) => {
      if (path === 'mcp-catalog') {
        return {
          find: catalogRead,
        };
      }
      if (path === 'mcp-catalog/readiness') {
        return { get: vi.fn(async () => ({ catalog_key: ENTRY.name, state: 'no_auth' })) };
      }
      if (path === 'mcp-member-policy') {
        return { find: vi.fn(async () => ({ policy: 'allow_crud', can_configure: true })) };
      }
      if (path === 'mcp-catalog/connect') return { create: connect };
      if (path === 'mcp-catalog/start-session') return { create: startSession };
      if (path === 'users') return { getPrimaryTeammate, getPrimaryTeammateCandidates };
      if (path === 'mcp-servers') return eventService;
      throw new Error(`Unexpected service ${path}`);
    }),
  } as unknown as AgorClient;
  return {
    client,
    catalogRead,
    connect,
    startSession,
    getPrimaryTeammate,
    getPrimaryTeammateCandidates,
  };
}

async function openDrawer() {
  fireEvent.click(await screen.findByLabelText('Open DeepWiki'));
  const disclosure = await screen.findByText('What this can access');
  const root = disclosure.closest('[role="dialog"]');
  if (!(root instanceof HTMLElement)) throw new Error('drawer not found');
  return { ...within(root), container: root };
}

beforeEach(() => {
  agorStore.getState().reset();
  mockNavigate.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('CatalogTab add then start-session flow', () => {
  it('persists without session fields, then uses eligible teammates for explicit session setup', async () => {
    const api = buildClient();
    render(
      <MemoryRouter>
        <CatalogTab
          client={api.client}
          connected
          connecting={false}
          authGeneration={1}
          currentUser={USER}
        />
      </MemoryRouter>
    );

    const drawer = await openDrawer();
    await drawer.findByText('No account expected');
    const checkbox = drawer.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const add = (await drawer.findByText('Connect')).closest('button');
    if (!checkbox || !add) throw new Error('add controls not found');
    fireEvent.click(checkbox);
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);

    await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
    expect(api.connect).toHaveBeenCalledWith({
      catalog_key: ENTRY.name,
      acknowledged_disclosure: ENTRY.permission_disclosure,
    });
    expect(api.getPrimaryTeammateCandidates).not.toHaveBeenCalled();
    expect(await drawer.findByText('Added to My Servers')).toBeInTheDocument();
    expect(drawer.queryByText('Starter prompt suggestion')).not.toBeInTheDocument();

    const beginButton = drawer.getByText('Start new session').closest('button');
    if (!beginButton) throw new Error('start-session setup button not found');
    fireEvent.click(beginButton);
    await waitFor(() => expect(api.getPrimaryTeammateCandidates).toHaveBeenCalledOnce());
    expect(await drawer.findByText('Ada')).toBeInTheDocument();
    const startButton = drawer.getByText('Start session').closest('button');
    if (!startButton) throw new Error('start-session button not found');
    fireEvent.click(startButton);

    await waitFor(() => expect(api.startSession).toHaveBeenCalledOnce());
    expect(api.startSession).toHaveBeenCalledWith({
      catalog_key: ENTRY.name,
      mcp_server_id: 'server-1',
      teammate_branch_id: TEAMMATE.branch_id,
      agentic_tool: 'claude-code',
    });
    expect(getPromptDraft(USER.user_id, SESSION_ID)).toBe('');
    expect(consumePromptDraftSeed(USER.user_id, SESSION_ID)).toBe(ENTRY.starter_prompt);
    expect(mockNavigate).toHaveBeenCalledWith(sessionPath(SESSION_ID));
  });

  it('uses the modal owner navigation callback after staging the exact new-session draft', async () => {
    const api = buildClient();
    const onOpenSession = vi.fn();
    render(
      <MemoryRouter>
        <CatalogTab
          client={api.client}
          connected
          connecting={false}
          authGeneration={1}
          currentUser={USER}
          onOpenSession={onOpenSession}
        />
      </MemoryRouter>
    );
    const drawer = await openDrawer();
    await drawer.findByText('No account expected');
    const checkbox = drawer.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const addButton = (await drawer.findByText('Connect')).closest('button');
    if (!checkbox || !addButton) throw new Error('add controls not found');
    fireEvent.click(checkbox);
    fireEvent.click(addButton);
    await drawer.findByText('Added to My Servers');
    const beginButton = drawer.getByText('Start new session').closest('button');
    if (!beginButton) throw new Error('start-session setup button not found');
    fireEvent.click(beginButton);
    await drawer.findByText('Ada');
    const startButton = drawer.getByText('Start session').closest('button');
    if (!startButton) throw new Error('start-session button not found');
    fireEvent.click(startButton);

    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith(SESSION_ID));
    expect(consumePromptDraftSeed(USER.user_id, SESSION_ID)).toBe(ENTRY.starter_prompt);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

it.each(['close', 'identity', 'generation'] as const)(
  'does not navigate or hydrate a stale session result after %s',
  async (transition) => {
    const api = buildClient();
    let resolve!: (result: Awaited<ReturnType<typeof api.startSession>>) => void;
    api.startSession.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const tree = (currentUser = USER, authGeneration = 1) => (
      <MemoryRouter>
        <CatalogTab
          client={api.client}
          connected
          connecting={false}
          currentUser={currentUser}
          authGeneration={authGeneration}
        />
      </MemoryRouter>
    );
    const view = render(tree());
    const drawer = await openDrawer();
    await drawer.findByText('No account expected');
    fireEvent.click(drawer.container.querySelector('input[type=checkbox]')!);
    const connect = drawer.getByText('Connect').closest('button')!;
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    fireEvent.click((await drawer.findByText('Start new session')).closest('button')!);
    const start = (await drawer.findByText('Start session')).closest('button')!;
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    fireEvent.click(start);
    expect(api.startSession).toHaveBeenCalledOnce();
    if (transition === 'close')
      fireEvent.click(drawer.container.querySelector('button.ant-drawer-close')!);
    else
      view.rerender(
        tree(transition === 'identity' ? ({ ...USER, user_id: 'other-user' } as User) : USER, 2)
      );
    await act(async () => {
      resolve({
        session: { session_id: SESSION_ID, branch_id: TEAMMATE.branch_id },
        starter_prompt: ENTRY.starter_prompt,
      });
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(consumePromptDraftSeed(USER.user_id, SESSION_ID)).toBe('');
  }
);

it('keeps setup and reports a refused session start without navigating or seeding a draft', async () => {
  const api = buildClient();
  api.startSession.mockRejectedValue(new Error('Teammate access was revoked'));
  render(
    <MemoryRouter>
      <CatalogTab
        client={api.client}
        connected
        connecting={false}
        currentUser={USER}
        authGeneration={1}
      />
    </MemoryRouter>
  );
  const drawer = await openDrawer();
  await drawer.findByText('No account expected');
  fireEvent.click(drawer.container.querySelector('input[type=checkbox]')!);
  const connect = drawer.getByText('Connect').closest('button')!;
  await waitFor(() => expect(connect).toBeEnabled());
  fireEvent.click(connect);
  fireEvent.click((await drawer.findByText('Start new session')).closest('button')!);
  const start = (await drawer.findByText('Start session')).closest('button')!;
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await drawer.findByText('Teammate access was revoked');
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(consumePromptDraftSeed(USER.user_id, SESSION_ID)).toBe('');
});

it('can connect again after closing a drawer with a pending installation', async () => {
  const api = buildClient();
  const installed = await api.connect();
  api.connect.mockClear();
  let resolve!: (value: typeof installed) => void;
  api.connect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  render(
    <MemoryRouter>
      <CatalogTab
        client={api.client}
        connected
        connecting={false}
        currentUser={USER}
        authGeneration={1}
      />
    </MemoryRouter>
  );
  const first = await openDrawer();
  await first.findByText('No account expected');
  fireEvent.click(first.container.querySelector('input[type=checkbox]')!);
  const connect = first.getByText('Connect').closest('button')!;
  await waitFor(() => expect(connect).toBeEnabled());
  fireEvent.click(connect);
  expect(api.connect).toHaveBeenCalledOnce();
  fireEvent.click(first.container.querySelector('button.ant-drawer-close')!);
  const reopened = await openDrawer();
  await reopened.findByText('No account expected');
  const consent = reopened.container.querySelector('input[type=checkbox]')! as HTMLInputElement;
  if (!consent.checked) fireEvent.click(consent);
  const retry = reopened.getByText('Connect').closest('button')!;
  await waitFor(() => expect(retry).toBeEnabled());
  await act(async () => {
    resolve(installed);
  });
  expect(reopened.queryByText('Added to My Servers')).not.toBeInTheDocument();
  fireEvent.click(retry);
  await reopened.findByText('Added to My Servers');
  expect(api.connect).toHaveBeenCalledTimes(2);
});

describe('explicit onboarding context', () => {
  it('installs without teammate reads, sessions, navigation or prompt staging and returns locally', async () => {
    const api = buildClient();
    const onConnected = vi.fn();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <CatalogTab
          client={api.client}
          connected
          connecting={false}
          authGeneration={1}
          currentUser={USER}
          context={{ mode: 'onboarding', entryName: ENTRY.name, onConnected, onClose }}
        />
      </MemoryRouter>
    );
    const dialog = within(await screen.findByRole('dialog', { name: /DeepWiki/ }));
    await dialog.findByText('No account expected');
    fireEvent.click(
      dialog.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Connect' }));
    await dialog.findByText('Connected and ready');
    expect(api.connect).toHaveBeenCalledWith({
      catalog_key: ENTRY.name,
      acknowledged_disclosure: ENTRY.permission_disclosure,
    });
    expect(onConnected).toHaveBeenCalledExactlyOnceWith('server-1');
    expect(api.getPrimaryTeammateCandidates).not.toHaveBeenCalled();
    expect(api.getPrimaryTeammate).not.toHaveBeenCalled();
    expect(api.startSession).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(consumePromptDraftSeed(USER.user_id, SESSION_ID)).toBe('');
    expect(dialog.queryByRole('combobox')).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: /Start.*session/ })).not.toBeInTheDocument();
    expect(dialog.queryByText(/new session|try.*server|starter prompt/i)).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Return to onboarding' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('redacts failed installation details and retries locally without session side effects', async () => {
    const api = buildClient();
    api.connect.mockRejectedValueOnce(new Error('secret-test-value echoed by a failed provider'));
    const onConnected = vi.fn();
    render(
      <MemoryRouter>
        <CatalogTab
          client={api.client}
          connected
          connecting={false}
          authGeneration={1}
          currentUser={USER}
          context={{ mode: 'onboarding', entryName: ENTRY.name, onConnected, onClose: vi.fn() }}
        />
      </MemoryRouter>
    );
    const dialog = within(await screen.findByRole('dialog', { name: /DeepWiki/ }));
    await dialog.findByText('No account expected');
    fireEvent.click(
      dialog.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Connect' }));
    await dialog.findByText('Could not connect this server. Check your credentials and try again.');
    expect(screen.queryByText(/secret-test-value/)).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Connect' }));
    await dialog.findByText('Connected and ready');
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(api.startSession).not.toHaveBeenCalled();
    expect(api.getPrimaryTeammateCandidates).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledExactlyOnceWith('server-1');
  });
});

it.each(['missing', 'error'] as const)(
  'keeps the onboarding drawer mounted across %s Catalog retry',
  async (initial) => {
    const api = buildClient();
    if (initial === 'missing')
      api.catalogRead.mockResolvedValueOnce({ total: 0, limit: 1, skip: 0, data: [] });
    else api.catalogRead.mockRejectedValueOnce(new Error('fixture catalog unavailable'));
    render(
      <MemoryRouter>
        <CatalogTab
          client={api.client}
          connected
          connecting={false}
          authGeneration={1}
          currentUser={USER}
          context={{
            mode: 'onboarding',
            entryName: ENTRY.name,
            onConnected: vi.fn(),
            onClose: vi.fn(),
          }}
        />
      </MemoryRouter>
    );
    const dialog = await screen.findByRole('dialog', { name: 'Catalog' });
    const root = dialog.closest('.ant-drawer');
    const retry = await within(dialog).findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    await screen.findByText(ENTRY.benefit);
    expect(document.querySelector('.ant-drawer')).toBe(root);
    expect(document.querySelectorAll('.ant-drawer')).toHaveLength(1);
    expect(api.catalogRead).toHaveBeenCalledTimes(2);
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.startSession).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  }
);

describe.each(['catalog', 'onboarding'] as const)('fresh Connect OAuth authority in %s', (mode) => {
  it.each([
    {
      name: 'stale positive badge, no live grant',
      cached: true,
      live: false,
      expires: undefined,
      ready: false,
    },
    {
      name: 'absent badge, live expiring grant',
      cached: false,
      live: true,
      expires: Date.now() + 3600000,
      ready: true,
    },
    {
      name: 'absent badge, live non-expiring grant',
      cached: false,
      live: true,
      expires: undefined,
      ready: true,
    },
    {
      name: 'stale positive badge, expired grant',
      cached: true,
      live: true,
      expires: 1,
      ready: false,
    },
    {
      name: 'stale positive badge, invalid expiry',
      cached: true,
      live: true,
      expires: Number.NaN,
      ready: false,
    },
  ])('$name', async ({ cached, live, expires, ready }) => {
    const api = buildClient();
    const response = await api.connect();
    api.connect.mockClear();
    const auth = {
      type: 'oauth',
      ...(live ? { oauth_access_token: MCP_HEADER_REDACTED_SENTINEL } : {}),
      ...(expires !== undefined ? { oauth_token_expires_at: expires } : {}),
    };
    api.connect.mockResolvedValue({ ...response, mcp_server: { ...response.mcp_server, auth } });
    agorStore.setState({ userAuthenticatedMcpServerIds: new Set(cached ? ['server-1'] : []) });
    const onConnected = vi.fn();
    render(
      <MemoryRouter>
        <CatalogTab
          client={api.client}
          connected
          connecting={false}
          authGeneration={1}
          currentUser={USER}
          context={
            mode === 'onboarding'
              ? { mode, entryName: ENTRY.name, onConnected, onClose: vi.fn() }
              : undefined
          }
        />
      </MemoryRouter>
    );
    if (mode === 'catalog') await openDrawer();
    const dialog = within(await screen.findByRole('dialog', { name: /DeepWiki/ }));
    await dialog.findByText('No account expected');
    fireEvent.click(
      dialog.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Connect' }));
    if (ready) {
      await dialog.findByText(
        mode === 'onboarding' ? 'Connected and ready' : 'Added to My Servers'
      );
      expect(dialog.queryByRole('button', { name: /Continue sign-in/ })).not.toBeInTheDocument();
    } else {
      await dialog.findByRole('button', { name: /Continue sign-in/ });
      expect(dialog.queryByText('Connected and ready')).not.toBeInTheDocument();
    }
    expect(onConnected).toHaveBeenCalledTimes(mode === 'onboarding' && ready ? 1 : 0);
    expect(api.client.service).not.toHaveBeenCalledWith('mcp-servers/oauth-start');
    expect(api.getPrimaryTeammateCandidates).not.toHaveBeenCalled();
    expect(api.startSession).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(consumePromptDraftSeed(USER.user_id, SESSION_ID)).toBe('');
  });
});
