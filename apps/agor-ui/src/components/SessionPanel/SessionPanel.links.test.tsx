import type { AgorClient, Board, Branch, Link, Session } from '@agor-live/client';
import { LINK_PROMOTION_TARGET } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { makeTestLink } from '../Links/testUtils';
import SessionPanel from './SessionPanel';

vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ state: { tasks: [] } }),
}));

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: () => <textarea aria-label="Prompt" />,
}));

vi.mock('../FileUpload', () => ({
  FileUpload: () => null,
}));

vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({
  ForkSpawnModal: () => null,
}));

vi.mock('../metadata', () => ({
  CreatedByTag: () => <span>Created by test user</span>,
}));

vi.mock('../Pill', () => ({
  ContextWindowPill: () => <span>Context window</span>,
  IssuePill: () => <span>Issue</span>,
  PullRequestPill: () => <span>PR</span>,
  TimerPill: () => <span>Timer</span>,
  TokenCountPill: () => <span>Tokens</span>,
}));

vi.mock('../SessionIds', () => ({
  SessionIdsButton: () => <span>Session IDs</span>,
  SessionIdsList: () => <span>Session IDs List</span>,
}));

vi.mock('../ToolIcon', () => ({
  ToolIcon: () => <span>Tool icon</span>,
}));

vi.mock('./SessionMcpFooterControl', () => ({
  SessionMcpFooterControl: () => null,
}));

vi.mock('./SessionPanelContent', () => ({
  SessionPanelContent: ({
    pinnedContextLinks = [],
  }: {
    pinnedContextLinks?: Array<{ key: string; name: string }>;
  }) => (
    <div>
      <div>Session content</div>
      {pinnedContextLinks.map((link) => (
        <span key={link.key}>{link.name}</span>
      ))}
    </div>
  ),
}));

vi.mock('./SessionRunSettingsPopover', () => ({
  SessionRunSettingsPopover: () => null,
}));

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const session = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  title: 'Links session',
  agentic_tool: 'codex',
  status: 'idle',
  archived: false,
  created_at: '2026-07-01T00:00:00.000Z',
  last_updated: '2026-07-01T00:00:00.000Z',
} as unknown as Session;

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  name: 'feature/links',
  path: '/tmp/feature-links',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

const makeLink = (overrides: Partial<Link> = {}) =>
  makeTestLink({
    url: 'https://example.com/session-runbook',
    is_pinned: true,
    title: 'Session Runbook',
    ...overrides,
  });

interface PromotionClientOptions {
  sessionLinks: Link[];
  branchLinks?: Link[];
  teammateLinks?: Link[];
  promoted: Link;
  materialized?: Link;
}

function makeClient(input: Link[] | PromotionClientOptions) {
  const promotion = Array.isArray(input) ? null : input;
  const sessionLinks = Array.isArray(input) ? input : input.sessionLinks;
  const branchLinks = promotion?.branchLinks ?? [];
  const teammateLinks = promotion?.teammateLinks ?? [];
  const links = [...sessionLinks, ...branchLinks, ...teammateLinks];
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const linksById = new Map(links.map((link) => [link.link_id, link]));
  const client = {
    service(path: string) {
      return {
        async find(args?: unknown) {
          calls.push({ service: path, method: 'find', args: [args] });
          if (path.endsWith('/tasks/queue')) return { data: [] };
          return [];
        },
        async findAll(params?: { query?: { owner_scope?: string; branch_id?: string } }) {
          calls.push({ service: path, method: 'findAll', args: [params] });
          if (!promotion) return path === 'links' ? links : [];
          if (params?.query?.owner_scope !== 'branch') return sessionLinks;
          return params.query.branch_id === branch.branch_id ? branchLinks : teammateLinks;
        },
        async patch(id: string, body: unknown) {
          calls.push({ service: path, method: 'patch', args: [id, body] });
          const existing = linksById.get(id);
          return { ...existing, ...(body as object), link_id: id };
        },
        ...(promotion && {
          async create(body: unknown) {
            calls.push({ service: path, method: 'create', args: [body] });
            if (path === 'links') return promotion.materialized ?? promotion.promoted;
            return promotion.promoted;
          },
        }),
        on: vi.fn(),
        off: vi.fn(),
      };
    },
  } as unknown as AgorClient;
  return { client, calls };
}

function makePromotionClient(options: PromotionClientOptions) {
  return makeClient(options);
}

function renderPanel(client: AgorClient, panelBranch: Branch = branch) {
  return render(
    <MemoryRouter>
      <ConnectionProvider value={connected}>
        <AppActionsProvider value={{}}>
          <AntApp>
            <SessionPanel
              client={client}
              session={session}
              branch={panelBranch}
              open
              onClose={vi.fn()}
            />
          </AntApp>
        </AppActionsProvider>
      </ConnectionProvider>
    </MemoryRouter>
  );
}

function seedPrimaryTeammate(state: Partial<ReturnType<typeof agorStore.getState>> = {}) {
  agorStore.setState({
    ...EMPTY_MAPS,
    ...state,
    boardById: new Map([
      ['board-1', { board_id: 'board-1', primary_teammate_id: 'teammate-1' } as Board],
    ]),
  });
}

describe('SessionPanel session links', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('hydrates full session links on open and renders from the centralized session selector', async () => {
    const link = makeLink();
    const { client, calls } = makeClient([link]);

    renderPanel(client);

    await screen.findByText('Session Runbook');
    await waitFor(() => {
      expect(calls.some((call) => call.service === 'links' && call.method === 'findAll')).toBe(
        true
      );
    });
    const linkFind = calls.find((call) => call.service === 'links' && call.method === 'findAll');
    expect(linkFind?.args[0]).toMatchObject({
      query: {
        owner_scope: 'session',
        session_id: 'session-1',
      },
    });
    expect(agorStore.getState().linksBySession.get('session-1')).toEqual([link]);
  });

  it('keeps branch-owned links out of the session strip and manager', async () => {
    const sessionPin = makeLink({ title: 'Session Runbook' });
    const branchPin = makeLink({
      link_id: 'branch-pin' as Link['link_id'],
      branch_id: branch.branch_id,
      session_id: null,
      title: 'Branch Runbook',
      url: 'https://example.com/branch-runbook',
      target_key: 'url:https://example.com/branch-runbook',
    });
    const { client } = makePromotionClient({
      sessionLinks: [sessionPin],
      branchLinks: [branchPin],
      promoted: branchPin,
    });

    renderPanel(client);

    expect(await screen.findByText('Session Runbook')).toBeInTheDocument();
    expect(screen.queryByText('Branch Runbook')).toBeNull();
    fireEvent.click(screen.getByLabelText('Open links organizer'));
    const popover = await screen.findByTestId('links-organizer-popover');
    expect(within(popover).getByText('Session Runbook')).toBeInTheDocument();
    expect(within(popover).queryByText('Branch Runbook')).toBeNull();
    fireEvent.click(within(popover).getByLabelText('Manage links'));
    const drawer = await screen.findByTestId('links-organizer-manage');
    expect(within(drawer).getByText('Session Runbook')).toBeInTheDocument();
    expect(within(drawer).queryByText('Branch Runbook')).toBeNull();
  });

  it('promotes a session link to the board primary teammate without removing it', async () => {
    const source = makeLink();
    const promoted = makeLink({
      ...source,
      link_id: 'teammate-link' as Link['link_id'],
      branch_id: 'teammate-1' as Link['branch_id'],
      session_id: null,
      revision: (source.revision ?? 1) + 1,
    });
    seedPrimaryTeammate();
    const { client, calls } = makePromotionClient({
      sessionLinks: [source],
      promoted,
    });

    renderPanel(client);

    await screen.findByText('Session Runbook');
    fireEvent.click(screen.getByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));
    fireEvent.click(await screen.findByLabelText('Actions for Session Runbook'));
    fireEvent.click(await screen.findByText('Promote to teammate'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links/link-1/promote',
        method: 'create',
        args: [{ target: LINK_PROMOTION_TARGET.teammate, teammate_branch_id: 'teammate-1' }],
      });
    });
    expect(agorStore.getState().linksBySession.get(session.session_id)).toEqual([source]);
    expect(agorStore.getState().linksByBranch.get('teammate-1')).toEqual([promoted]);
  });

  it('opens the manage drawer from the header gear and searches drawer links', async () => {
    const runbook = makeLink();
    const apiGuide = makeLink({
      link_id: 'link-api' as Link['link_id'],
      is_pinned: false,
      title: 'API guide',
      url: 'https://example.com/api-guide',
      target_key: 'url:https://example.com/api-guide',
    });
    const { client } = makeClient([runbook, apiGuide]);

    renderPanel(client);

    await screen.findByText('Session Runbook');
    fireEvent.click(screen.getByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));

    const drawer = await screen.findByTestId('links-organizer-manage');
    expect(screen.getByLabelText('Search links')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search links'), {
      target: { value: 'api' },
    });

    await waitFor(() => expect(within(drawer).queryByText('Session Runbook')).toBeNull());
    expect(within(drawer).getByText('API guide')).toBeTruthy();
  });

  it('keeps file-backed links distinct when paths differ only by case', async () => {
    const upper = makeLink({
      link_id: 'upper-report' as Link['link_id'],
      kind: 'document',
      source: 'upload',
      title: 'Report.pdf',
      file_path: '/tmp/uploads/Report.pdf',
      mime_type: 'application/pdf',
      target_key: 'file:/tmp/uploads/Report.pdf',
      is_pinned: false,
    });
    const lower = makeLink({
      link_id: 'lower-report' as Link['link_id'],
      kind: 'document',
      source: 'upload',
      title: 'report.pdf',
      file_path: '/tmp/uploads/report.pdf',
      mime_type: 'application/pdf',
      target_key: 'file:/tmp/uploads/report.pdf',
      is_pinned: false,
    });
    const { client } = makeClient([upper, lower]);
    agorStore.setState({
      ...EMPTY_MAPS,
      linksBySession: new Map([['session-1', [upper, lower]]]),
      linkById: new Map([
        [upper.link_id, upper],
        [lower.link_id, lower],
      ]),
    });

    renderPanel(client);

    fireEvent.click(await screen.findByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));

    const drawer = await screen.findByTestId('links-organizer-manage');
    expect(within(drawer).getByText('Report.pdf')).toBeTruthy();
    expect(within(drawer).getByText('report.pdf')).toBeTruthy();
  });
});
