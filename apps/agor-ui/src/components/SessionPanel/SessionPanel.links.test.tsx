import type { AgorClient, Board, Branch, Link, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
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
    pinnedSessionLinks = [],
  }: {
    pinnedSessionLinks?: Array<{ key: string; name: string }>;
  }) => (
    <div>
      <div>Session content</div>
      {pinnedSessionLinks.map((link) => (
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

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    link_id: 'link-1',
    branch_id: null,
    session_id: 'session-1',
    source_message_id: null,
    kind: 'url',
    source: 'manual',
    url: 'https://example.com/session-runbook',
    ref_uri: null,
    file_path: null,
    target_key: 'url:https://example.com/session-runbook',
    is_pinned: true,
    title: 'Session Runbook',
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as Link;
}

function makeClient(links: Link[]) {
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
        async findAll(args?: unknown) {
          calls.push({ service: path, method: 'findAll', args: [args] });
          if (path === 'links') return links;
          return [];
        },
        async patch(id: string, body: unknown) {
          calls.push({ service: path, method: 'patch', args: [id, body] });
          const existing = linksById.get(id);
          return { ...existing, ...(body as object), link_id: id };
        },
        on: vi.fn(),
        off: vi.fn(),
      };
    },
  } as unknown as AgorClient;
  return { client, calls };
}

function makePromotionClient(args: {
  sessionLinks: Link[];
  assistantLinks: Link[];
  promoted: Link;
}) {
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
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
          if (params?.query?.owner_scope === 'branch') return args.assistantLinks;
          return args.sessionLinks;
        },
        async patch(id: string, body: unknown) {
          calls.push({ service: path, method: 'patch', args: [id, body] });
          return {
            ...args.sessionLinks.find((link) => link.link_id === id),
            ...(body as object),
            link_id: id,
          };
        },
        async create(body: unknown) {
          calls.push({ service: path, method: 'create', args: [body] });
          return args.promoted;
        },
        async remove(id: string) {
          calls.push({ service: path, method: 'remove', args: [id] });
          return args.promoted;
        },
        on: vi.fn(),
        off: vi.fn(),
      };
    },
  } as unknown as AgorClient;
  return { client, calls };
}

function renderPanel(client: AgorClient) {
  return render(
    <MemoryRouter>
      <ConnectionProvider value={connected}>
        <AppActionsProvider value={{}}>
          <AntApp>
            <SessionPanel
              client={client}
              session={session}
              branch={branch}
              open
              onClose={vi.fn()}
            />
          </AntApp>
        </AppActionsProvider>
      </ConnectionProvider>
    </MemoryRouter>
  );
}

describe('SessionPanel session links', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('hydrates full session links on open and renders from the centralized session selector', async () => {
    const link = makeLink();
    const { client, calls } = makeClient([link]);

    render(
      <MemoryRouter>
        <ConnectionProvider value={connected}>
          <AppActionsProvider value={{}}>
            <AntApp>
              <SessionPanel
                client={client}
                session={session}
                branch={branch}
                open
                onClose={vi.fn()}
              />
            </AntApp>
          </AppActionsProvider>
        </ConnectionProvider>
      </MemoryRouter>
    );

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

  it('promotes a session link to the board primary assistant', async () => {
    const source = makeLink();
    const promoted = makeLink({
      link_id: 'assistant-link' as Link['link_id'],
      branch_id: 'assistant-1' as Link['branch_id'],
      session_id: null,
      is_pinned: true,
    });
    agorStore.setState({
      ...EMPTY_MAPS,
      boardById: new Map([
        ['board-1', { board_id: 'board-1', primary_assistant_id: 'assistant-1' } as Board],
      ]),
    });
    const { client, calls } = makePromotionClient({
      sessionLinks: [source],
      assistantLinks: [],
      promoted,
    });

    renderPanel(client);

    await screen.findByText('Session Runbook');
    fireEvent.click(screen.getByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));
    fireEvent.click(await screen.findByLabelText('Assistant actions for Session Runbook'));
    fireEvent.click(await screen.findByText('Promote to assistant'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links/link-1/promote',
        method: 'create',
        args: [{ target: 'assistant', assistant_branch_id: 'assistant-1' }],
      });
    });
    expect(agorStore.getState().linksByBranch.get('assistant-1')).toEqual([promoted]);
  });

  it('removes an assistant copy from the session links popover', async () => {
    const source = makeLink();
    const promoted = makeLink({
      link_id: 'assistant-link' as Link['link_id'],
      branch_id: 'assistant-1' as Link['branch_id'],
      session_id: null,
      is_pinned: true,
    });
    agorStore.setState({
      ...EMPTY_MAPS,
      boardById: new Map([
        ['board-1', { board_id: 'board-1', primary_assistant_id: 'assistant-1' } as Board],
      ]),
      linksByBranch: new Map([['assistant-1', [promoted]]]),
      linkById: new Map([[promoted.link_id, promoted]]),
    });
    const { client, calls } = makePromotionClient({
      sessionLinks: [source],
      assistantLinks: [promoted],
      promoted,
    });

    renderPanel(client);

    await screen.findByText('Session Runbook');
    fireEvent.click(screen.getByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));
    fireEvent.click(await screen.findByLabelText('Assistant actions for Session Runbook'));
    fireEvent.click(await screen.findByText('Remove from assistant'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links',
        method: 'remove',
        args: ['assistant-link'],
      });
    });
    expect(agorStore.getState().linkById.has('assistant-link')).toBe(false);
    expect(agorStore.getState().linksBySession.get('session-1')).toEqual([source]);
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
