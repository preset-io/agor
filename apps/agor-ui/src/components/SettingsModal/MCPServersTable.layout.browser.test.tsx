/** Structured settings tables in the actual Settings shell, using synthetic inventories. */
import type {
  AgorClient,
  Artifact,
  Board,
  Branch,
  GatewayChannel,
  MCPServer,
  Repo,
  User,
} from '@agor-live/client';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { SettingsModal } from './SettingsModal';

const ADMIN = {
  user_id: 'layout-admin',
  email: 'alex@example.test',
  name: 'Alex Morgan',
  role: 'admin',
} as User;
const SAM = { ...ADMIN, user_id: 'layout-sam', name: 'Sam Lee', email: 'sam@example.test' } as User;
const TEAMMATE_NAMES = ['Ada', 'Atlas', 'Relay', 'Scout', 'Scribe'];
const SERVER_NAMES = ['GitHub', 'Internal docs', 'Playwright', 'Search', 'Team wiki'];
const CHANNEL_NAMES = ['Engineering', 'PR reviews', 'Dev community', 'Operations', 'Support'];
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
const service = vi.fn((name: string) => {
  if (name === 'mcp-member-policy')
    return {
      find: vi.fn(async () => ({ policy: 'allow_crud', can_configure: true })),
      patch: vi.fn(),
    };
  return { on: vi.fn(), removeListener: vi.fn() };
});
const client = { io: { on: vi.fn(), off: vi.fn() }, service } as unknown as AgorClient;

function renderSettings(
  dark: boolean,
  tab: 'mcp' | 'gateway' | 'teammates' | 'artifacts',
  longName = false
) {
  const servers = SERVER_NAMES.map(
    (name, index) =>
      ({
        mcp_server_id: `server-${index}`,
        name: name.toLowerCase().replaceAll(' ', '-'),
        display_name:
          longName && index === 0
            ? 'An unusually long server name that should truncate rather than grow the row'
            : name,
        description: index === 0 ? 'Review pull requests and issues.' : undefined,
        transport: index === 2 ? 'stdio' : 'http',
        scope: index % 2 ? 'session' : 'global',
        source: 'user',
        owner_user_id: index % 2 ? undefined : index === 2 ? SAM.user_id : ADMIN.user_id,
        enabled: index !== 3,
        tools: index === 4 ? [] : [{ name: 'search' }],
        auth: index === 4 ? { type: 'oauth', oauth_mode: 'per_user' } : undefined,
        created_at: new Date('2026-01-01'),
      }) as unknown as MCPServer
  );
  const branches = TEAMMATE_NAMES.map(
    (name, index) =>
      ({
        branch_id: `teammate-${index}`,
        name: `${name.toLowerCase()}-home`,
        repo_id: 'repo',
        board_id: `board-${index % 2}`,
        primary_owner_user_id: index % 2 ? SAM.user_id : ADMIN.user_id,
        created_by: 'unlisted-creator',
        notes: index === 0 ? 'Coordinates engineering work across branches.' : undefined,
        custom_context: { teammate: { kind: 'teammate', displayName: name } },
      }) as unknown as Branch
  );
  const channels = CHANNEL_NAMES.map(
    (name, index) =>
      ({
        id: `channel-${index}`,
        name,
        created_by: index % 2 ? SAM.user_id : ADMIN.user_id,
        agor_user_id: ADMIN.user_id,
        channel_type: ['slack', 'github', 'discord', 'teams', 'slack'][index],
        target_branch_id: 'not-in-inventory',
        enabled: index !== 2,
        config: {},
      }) as unknown as GatewayChannel
  );
  const artifacts = [
    'API explorer',
    'Launch checklist',
    'Metrics dashboard',
    'Release notes',
    'Team directory',
  ].map(
    (name, index) =>
      ({
        artifact_id: `artifact-${index}`,
        name,
        description: index === 0 ? 'Explore the API with synthetic examples.' : undefined,
        board_id: `board-${index % 2}`,
        branch_id: branches[index].branch_id,
        created_by: index % 2 ? SAM.user_id : ADMIN.user_id,
        template: index % 2 ? 'static' : 'react-ts',
        build_status: index === 2 ? 'error' : 'success',
        created_at: '2026-01-01T00:00:00Z',
        archived: false,
      }) as Artifact
  );
  agorStore.setState({
    artifactById: new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact])),
    mcpServerById: new Map(servers.map((server) => [server.mcp_server_id, server])),
    userById: new Map([
      [ADMIN.user_id, ADMIN],
      [SAM.user_id, SAM],
    ]),
    gatewayChannelById: new Map(channels.map((channel) => [channel.id, channel])),
    branchById: new Map(branches.map((branch) => [branch.branch_id, branch])),
    repoById: new Map([['repo', { repo_id: 'repo', name: 'agor-teammate' } as Repo]]),
    boardById: new Map([
      ['board-0', { board_id: 'board-0', name: 'Engineering' } as Board],
      ['board-1', { board_id: 'board-1', name: 'Platform' } as Board],
    ]),
  });
  return render(
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { motion: false },
      }}
    >
      <MemoryRouter>
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
              activeTab={tab}
              currentUser={ADMIN}
              client={client}
              onClose={vi.fn()}
              onCreateTeammate={vi.fn()}
            />
          </ConnectionProvider>
        </AntdApp>
      </MemoryRouter>
    </ConfigProvider>
  );
}

function expectInside(container: HTMLElement, element: HTMLElement) {
  const bounds = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
  expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
}

beforeEach(() => agorStore.getState().reset());
afterEach(async () => {
  cleanup();
  agorStore.getState().reset();
  await page.viewport(originalViewport.width, originalViewport.height);
});

const headers = {
  mcp: ['Server', 'Owner', 'Enabled', 'Access / discovery', 'Actions'],
  teammates: ['Teammate', 'Primary owner', 'Board', 'Actions'],
  gateway: ['Channel', 'Created by', 'Enabled', 'Actions'],
  artifacts: ['Artifact', 'Board', 'Owner', 'Build', 'Actions'],
};

describe.each(['mcp', 'gateway', 'teammates', 'artifacts'] as const)(
  '%s structured settings',
  (tab) => {
    it.each([false, true])('fits realistic rows, dark=%s', async (dark) => {
      renderSettings(dark, tab);
      const dialog = screen.getByRole('dialog');
      await waitFor(() =>
        expect(
          screen.getAllByRole('button', {
            name:
              tab === 'teammates'
                ? 'Edit teammate'
                : tab === 'artifacts'
                  ? 'Edit artifact'
                  : 'Edit',
            exact: true,
          })[0]
        ).toBeEnabled()
      );
      const edit = screen.getAllByRole('button', {
        name:
          tab === 'teammates' ? 'Edit teammate' : tab === 'artifacts' ? 'Edit artifact' : 'Edit',
        exact: true,
      })[0];
      await waitFor(() => expect(edit).toBeVisible());
      expectInside(dialog, edit);
      expectInside(dialog, within(dialog).getByRole('textbox'));
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      if (window.innerWidth >= 768) {
        const table = screen.getByRole('table');
        expect(
          within(table)
            .getAllByRole('columnheader')
            .map((header) => header.textContent)
        ).toEqual(headers[tab]);
        expect(table.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(5);
        // MCP retains a bounded horizontal scroller only in the narrow desktop shell;
        // the fixed actions remain reachable rather than clipping outside the modal.
        const viewport = table.closest('.ant-table-content') as HTMLElement;
        expectInside(viewport, edit);
        for (const identity of table.querySelectorAll<HTMLElement>('[data-settings-identity]')) {
          expect(identity.getBoundingClientRect().height).toBeLessThanOrEqual(52);
        }
      }
      await page.screenshot({
        path: `./.vitest/settings-${tab}-${dark ? 'dark' : 'light'}-${window.innerWidth}.png`,
      });
      if (window.innerWidth === 1000) {
        await page.viewport(1440, 1000);
        await page.screenshot({
          path: `./.vitest/settings-${tab}-${dark ? 'dark' : 'light'}-1440.png`,
        });
      }
      edit.focus();
      expect(edit).toHaveFocus();
      if (tab !== 'gateway') {
        screen.getByRole('button', { name: /^Description for/ }).focus();
        await userEvent.keyboard('{Enter}');
        expect(
          await screen.findByText(
            tab === 'mcp'
              ? 'Review pull requests and issues.'
              : tab === 'artifacts'
                ? 'Explore the API with synthetic examples.'
                : 'Coordinates engineering work across branches.'
          )
        ).toBeVisible();
      }
      if (tab === 'mcp') expect(screen.getByText('Not signed in')).toBeInTheDocument();
      if (tab === 'gateway')
        expect(screen.queryByText('Beta Feature — Security Notice')).not.toBeInTheDocument();
      if (tab === 'gateway') expect(screen.queryByText(/Execution owner/)).not.toBeInTheDocument();
    });
  }
);

it('ellipsizes an unusually long name without growing the identity beyond two lines', async () => {
  renderSettings(false, 'mcp', true);
  const label = screen.getByText(
    'An unusually long server name that should truncate rather than grow the row'
  );
  await waitFor(() => expect(label).toBeVisible());
  const identity = label.closest('[data-settings-identity]') as HTMLElement;
  expect(identity.getBoundingClientRect().height).toBeLessThanOrEqual(52);
  expect(label.getBoundingClientRect().height).toBeLessThanOrEqual(24);
});
