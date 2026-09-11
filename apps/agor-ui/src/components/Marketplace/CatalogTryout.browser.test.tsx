import type { Branch, MCPCatalogEntry, SessionID } from '@agor/core/types';
import { type AgorClient, type Session, sessionPath, type User } from '@agor-live/client';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import SessionPanel from '../SessionPanel/SessionPanel';
import { MCPCatalogModal } from './MCPCatalogModal';

// Exercise the actual modal, navigation, and composer; the unrelated historical
// message stream is not part of this install/start-session API fixture.
vi.mock('../SessionPanel/SessionPanelContent', () => ({ SessionPanelContent: () => null }));
vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ handle: null, state: { tasks: [] } }),
}));
checkBrowserSanity();
configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => {
  agorStore.getState().reset();
  localStorage.clear();
  sessionStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(cleanup);

const user = { user_id: 'catalog-browser-user', role: 'member' } as User;
const entry = {
  name: 'com.deepwiki/mcp',
  title: 'DeepWiki',
  category: 'dev-tools',
  permission_disclosure: 'Reads public GitHub repository content only.',
  starter_prompt: 'Explain how authentication works in a repository I name.',
  capabilities: ['docs'],
  has_remote: true,
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
  auth_type: 'none',
} as MCPCatalogEntry;
const teammates = ['Ada', 'Grace'].map((name, index) => ({
  branch_id: `teammate-${index}`,
  name,
  custom_context: { teammate: { kind: 'teammate', displayName: name } },
})) as Branch[];
const session = {
  session_id: 'tryout-session' as SessionID,
  branch_id: teammates[1].branch_id,
  title: 'DeepWiki',
  status: 'idle',
  agentic_tool: 'codex',
  created_by: user.user_id,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as Session;

function fixture() {
  let finishConnect!: () => void;
  const connect = vi.fn(
    () =>
      new Promise((resolve) => {
        finishConnect = () =>
          resolve({
            mcp_server: { mcp_server_id: 'server-1', enabled: true, auth: { type: 'none' } },
            reused_existing_server: false,
            starter_prompt: entry.starter_prompt,
          });
      })
  );
  const candidates = vi.fn(async () => teammates);
  const start = vi.fn(async () => ({ session, starter_prompt: entry.starter_prompt }));
  const send = vi.fn();
  const events = { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
  const services: Record<string, object> = {
    'mcp-catalog': { find: async () => ({ data: [entry], total: 1, limit: 1, skip: 0 }) },
    'mcp-catalog/readiness': { get: async () => ({ catalog_key: entry.name, state: 'no_auth' }) },
    'mcp-member-policy': { find: async () => ({ policy: 'allow_crud', can_configure: true }) },
    'mcp-marketplace': {
      find: async () => ({
        servers: [],
        attachments: [],
        credentials: [],
        generated_at: new Date().toISOString(),
      }),
    },
    'mcp-catalog/connect': { create: connect },
    'mcp-catalog/start-session': { create: start },
    users: {
      getPrimaryTeammate: async () => teammates[0],
      getPrimaryTeammateCandidates: candidates,
    },
  };
  const client = {
    io: events,
    service: (name: string) => ({ ...events, find: async () => ({ data: [] }), ...services[name] }),
  } as unknown as AgorClient;
  function Flow() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <ConfigProvider>
        <App>
          <ConnectionProvider
            value={{
              connected: true,
              connecting: false,
              outOfSync: false,
              capturedSha: null,
              currentSha: null,
            }}
          >
            <output aria-label="Current route">{location.pathname}</output>
            {location.pathname === '/' ? (
              <MCPCatalogModal
                client={client}
                connected
                connecting={false}
                authGeneration={1}
                currentUser={user}
                open
                onClose={vi.fn()}
                afterClose={vi.fn()}
                onOpenSession={(id) => navigate(sessionPath(id))}
              />
            ) : (
              <AppActionsProvider value={{ onSendPrompt: send }}>
                <SessionPanel
                  client={client}
                  session={session}
                  currentUserId={user.user_id}
                  open
                  onClose={vi.fn()}
                />
              </AppActionsProvider>
            )}
          </ConnectionProvider>
        </App>
      </ConfigProvider>
    );
  }
  render(
    <MemoryRouter>
      <Flow />
    </MemoryRouter>
  );
  return { connect, candidates, start, send, finishConnect: () => finishConnect() };
}

describe('recovered Catalog tryout flow in Chromium', () => {
  it('waits for install, chooses an eligible teammate, navigates, and hydrates an editable unsent composer', async () => {
    const api = fixture();
    await userEvent.click(await screen.findByRole('button', { name: 'Open DeepWiki' }));
    const drawer = within(
      screen.getByText('What this can access').closest<HTMLElement>('[role="dialog"]')!
    );
    expect(drawer.queryByRole('combobox')).not.toBeInTheDocument();
    expect(api.candidates).not.toHaveBeenCalled();
    const dialog = screen
      .getByText('What this can access')
      .closest<HTMLElement>('[role="dialog"]')!;
    const wrapper = dialog.closest<HTMLElement>('.ant-drawer-content-wrapper')!;
    // Native pointer input must wait for the shared drawer's slide-in motion.
    await waitFor(() => {
      expect(dialog.getBoundingClientRect().right).toBeCloseTo(window.innerWidth, 1);
      expect(wrapper.getAnimations().some((animation) => animation.playState === 'running')).toBe(
        false
      );
    });
    await userEvent.click(drawer.getByRole('checkbox'));
    await waitFor(() => expect(drawer.getByRole('checkbox')).toBeChecked());
    await userEvent.click(drawer.getByRole('button', { name: 'Connect', exact: true }));
    expect(api.connect).toHaveBeenCalledWith({
      catalog_key: entry.name,
      acknowledged_disclosure: entry.permission_disclosure,
    });
    expect(api.start).not.toHaveBeenCalled();
    expect(api.candidates).not.toHaveBeenCalled();
    expect(drawer.queryByText('Teammate')).not.toBeInTheDocument();
    api.finishConnect();
    await drawer.findByText('Added to My Servers');
    expect(api.candidates).not.toHaveBeenCalled();
    await userEvent.click(drawer.getByRole('button', { name: 'Start new session' }));
    await waitFor(() => expect(api.candidates).toHaveBeenCalledOnce());
    await userEvent.click(drawer.getByRole('combobox', { name: 'Teammate' }));
    await userEvent.click(
      await screen.findByText('Grace', { selector: '.ant-select-item-option-content' })
    );
    await userEvent.click(drawer.getByRole('combobox', { name: 'Agent tool' }));
    await userEvent.click(
      await screen.findByText('Codex', { selector: '.ant-select-item-option-content' })
    );
    await page.screenshot({ path: `./__screenshots__/tryout-setup-${window.innerWidth}.png` });
    await userEvent.click(drawer.getByRole('button', { name: 'Start session', exact: true }));
    await waitFor(() =>
      expect(api.start).toHaveBeenCalledWith({
        catalog_key: entry.name,
        mcp_server_id: 'server-1',
        teammate_branch_id: teammates[1].branch_id,
        agentic_tool: 'codex',
      })
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Current route')).toHaveTextContent(
        sessionPath(session.session_id)
      )
    );
    const composer = await screen.findByPlaceholderText(/Prompt here/i);
    await waitFor(() => expect(composer).toHaveValue(entry.starter_prompt));
    expect(api.send).not.toHaveBeenCalled();
    expect(screen.queryByText('Starter prompt suggestion')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^(Insert prompt|Copy|Dismiss)$/i })
    ).not.toBeInTheDocument();
    await page.screenshot({ path: `./__screenshots__/tryout-hydrated-${window.innerWidth}.png` });
    await userEvent.fill(composer, 'My edited starter — still not sent');
    expect(composer).toHaveValue('My edited starter — still not sent');
    expect(api.send).not.toHaveBeenCalled();
    await page.screenshot({ path: `./__screenshots__/tryout-composer-${window.innerWidth}.png` });
  });
});
