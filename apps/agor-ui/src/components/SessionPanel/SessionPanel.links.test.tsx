import type { AgorClient, Board, Branch, Link, LinkMoveResult, Session } from '@agor-live/client';
import { LINK_MOVE_TARGET } from '@agor-live/client';
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

const branchWithIssue = {
  ...branch,
  issue_url: 'https://github.com/preset-io/agor/issues/154',
} as Branch;

const makeLink = (overrides: Partial<Link> = {}) =>
  makeTestLink({
    url: 'https://example.com/session-runbook',
    is_pinned: true,
    title: 'Session Runbook',
    ...overrides,
  });

interface MoveClientOptions {
  sessionLinks: Link[];
  branchLinks?: Link[];
  teammateLinks?: Link[];
  moved: Link;
  materialized?: Link;
  moveResult?: LinkMoveResult;
}

function makeClient(input: Link[] | MoveClientOptions) {
  const move = Array.isArray(input) ? null : input;
  const sessionLinks = Array.isArray(input) ? input : input.sessionLinks;
  const branchLinks = move?.branchLinks ?? [];
  const teammateLinks = move?.teammateLinks ?? [];
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
          if (!move) return path === 'links' ? links : [];
          if (params?.query?.owner_scope !== 'branch') return sessionLinks;
          return params.query.branch_id === branch.branch_id ? branchLinks : teammateLinks;
        },
        async patch(id: string, body: unknown) {
          calls.push({ service: path, method: 'patch', args: [id, body] });
          const existing = linksById.get(id);
          return { ...existing, ...(body as object), link_id: id };
        },
        ...(move && {
          async create(body: unknown) {
            calls.push({ service: path, method: 'create', args: [body] });
            if (path === 'links') return move.materialized ?? move.moved;
            if (path.endsWith('/move')) {
              return (
                move.moveResult ?? {
                  link: move.moved,
                  previous_link: sessionLinks[0] ?? branchLinks[0] ?? move.materialized,
                  merged: false,
                }
              );
            }
            return move.moved;
          },
        }),
        on: vi.fn(),
        off: vi.fn(),
      };
    },
  } as unknown as AgorClient;
  return { client, calls };
}

function makeMoveClient(options: MoveClientOptions) {
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

  it('shows the same mixed branch and session pins in the conversation strip', async () => {
    const sessionPin = makeLink({ title: 'Session Runbook' });
    const branchPin = makeLink({
      link_id: 'branch-pin' as Link['link_id'],
      branch_id: branch.branch_id,
      session_id: null,
      title: 'Branch Runbook',
      url: 'https://example.com/branch-runbook',
      target_key: 'url:https://example.com/branch-runbook',
    });
    const { client } = makeMoveClient({
      sessionLinks: [sessionPin],
      branchLinks: [branchPin],
      moved: branchPin,
    });

    renderPanel(client);

    expect(await screen.findByText('Session Runbook')).toBeInTheDocument();
    expect(await screen.findByText('Branch Runbook')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Open links organizer'));
    const popover = await screen.findByTestId('links-organizer-popover');
    expect(within(popover).getByText('Session Runbook')).toBeInTheDocument();
    expect(within(popover).getByText('Branch Runbook')).toBeInTheDocument();
  });

  it('deduplicates same-target session and branch pins before rendering the strip', async () => {
    const sessionPin = makeLink({ title: 'Session Runbook' });
    const duplicateBranchPin = makeLink({
      link_id: 'branch-pin' as Link['link_id'],
      branch_id: branch.branch_id,
      session_id: null,
      title: 'Branch duplicate',
    });
    const { client } = makeMoveClient({
      sessionLinks: [sessionPin],
      branchLinks: [duplicateBranchPin],
      moved: duplicateBranchPin,
    });

    renderPanel(client);

    expect(await screen.findByText('Session Runbook')).toBeInTheDocument();
    await waitFor(() =>
      expect(agorStore.getState().linksByBranch.get(branch.branch_id)).toEqual([duplicateBranchPin])
    );
    expect(screen.queryByText('Branch duplicate')).toBeNull();
  });

  it('adds a branch link materialized from the session organizer to the store', async () => {
    const pinnedIssue = makeLink({
      link_id: 'issue-link' as Link['link_id'],
      branch_id: branch.branch_id,
      session_id: null,
      kind: 'issue',
      title: 'preset-io/agor#154',
      url: branchWithIssue.issue_url,
      target_key: 'url:https://github.com/preset-io/agor/issues/154',
      is_pinned: true,
    });
    const { client, calls } = makeMoveClient({
      sessionLinks: [],
      moved: pinnedIssue,
    });

    renderPanel(client, branchWithIssue);

    fireEvent.click(await screen.findByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin preset-io/agor#154' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        service: 'links',
        method: 'create',
        args: [expect.objectContaining({ is_pinned: true, url: branchWithIssue.issue_url })],
      })
    );
    expect(agorStore.getState().linkById.get(pinnedIssue.link_id)).toEqual(pinnedIssue);
    expect(agorStore.getState().linksByBranch.get(branch.branch_id)).toEqual([pinnedIssue]);
  });

  it('hydrates an existing branch URL so it can be moved from the session organizer', async () => {
    const existingIssue = makeLink({
      link_id: 'issue-link' as Link['link_id'],
      branch_id: branch.branch_id,
      session_id: null,
      kind: 'issue',
      title: 'preset-io/agor#154',
      url: branchWithIssue.issue_url,
      target_key: 'url:https://github.com/preset-io/agor/issues/154',
      is_pinned: true,
    });
    const movedIssue = makeLink({
      ...existingIssue,
      branch_id: 'teammate-1' as Link['branch_id'],
      revision: (existingIssue.revision ?? 1) + 1,
    });
    seedPrimaryTeammate();
    const { client, calls } = makeMoveClient({
      sessionLinks: [],
      branchLinks: [existingIssue],
      moved: movedIssue,
      moveResult: { link: movedIssue, previous_link: existingIssue, merged: false },
    });

    renderPanel(client, branchWithIssue);

    fireEvent.click(await screen.findByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));
    fireEvent.click(await screen.findByLabelText('Actions for preset-io/agor#154'));
    fireEvent.click(await screen.findByText('Move to teammate'));

    await waitFor(() =>
      expect(calls).toContainEqual({
        service: 'links/issue-link/move',
        method: 'create',
        args: [{ target: LINK_MOVE_TARGET.branch, branch_id: 'teammate-1' }],
      })
    );
    expect(agorStore.getState().linksByBranch.get(branch.branch_id)).toBeUndefined();
    expect(agorStore.getState().linksByBranch.get('teammate-1')).toEqual([movedIssue]);
  });

  it('patches an existing branch URL when pinning it from the session organizer', async () => {
    const existingIssue = makeLink({
      link_id: 'issue-link' as Link['link_id'],
      branch_id: branch.branch_id,
      session_id: null,
      kind: 'issue',
      title: 'preset-io/agor#154',
      url: branchWithIssue.issue_url,
      target_key: 'url:https://github.com/preset-io/agor/issues/154',
      is_pinned: false,
    });
    const { client, calls } = makeMoveClient({
      sessionLinks: [],
      branchLinks: [existingIssue],
      moved: existingIssue,
    });

    renderPanel(client, branchWithIssue);

    fireEvent.click(await screen.findByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin preset-io/agor#154' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        service: 'links',
        method: 'patch',
        args: ['issue-link', { is_pinned: true }],
      })
    );
    expect(agorStore.getState().linkById.get(existingIssue.link_id)?.is_pinned).toBe(true);
    expect(calls.some((call) => call.service === 'links' && call.method === 'create')).toBe(false);
  });

  it('moves a session link to the board primary teammate', async () => {
    const source = makeLink();
    const moved = makeLink({
      ...source,
      branch_id: 'teammate-1' as Link['branch_id'],
      session_id: null,
      revision: (source.revision ?? 1) + 1,
    });
    seedPrimaryTeammate();
    const { client, calls } = makeMoveClient({
      sessionLinks: [source],
      moved,
      moveResult: { link: moved, previous_link: source, merged: false },
    });

    renderPanel(client);

    await screen.findByText('Session Runbook');
    fireEvent.click(screen.getByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));
    fireEvent.click(await screen.findByLabelText('Actions for Session Runbook'));
    fireEvent.click(await screen.findByText('Move to teammate'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links/link-1/move',
        method: 'create',
        args: [{ target: LINK_MOVE_TARGET.branch, branch_id: 'teammate-1' }],
      });
    });
    expect(agorStore.getState().linksBySession.get(session.session_id)).toBeUndefined();
    expect(agorStore.getState().linksByBranch.get('teammate-1')).toEqual([moved]);
  });

  it('moves a branch link into the current session instead of disabling the action', async () => {
    const source = makeLink({
      branch_id: branch.branch_id,
      session_id: null,
      title: 'Branch Runbook',
    });
    const moved = makeLink({
      ...source,
      branch_id: null,
      session_id: session.session_id,
      revision: (source.revision ?? 1) + 1,
    });
    seedPrimaryTeammate();
    const { client, calls } = makeMoveClient({
      sessionLinks: [],
      branchLinks: [source],
      moved,
      moveResult: { link: moved, previous_link: source, merged: false },
    });

    renderPanel(client);

    await screen.findByText('Branch Runbook');
    fireEvent.click(screen.getByLabelText('Open links organizer'));
    fireEvent.click(await screen.findByLabelText('Manage links'));
    fireEvent.click(await screen.findByLabelText('Actions for Branch Runbook'));
    fireEvent.click(await screen.findByText('Move to this session'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links/link-1/move',
        method: 'create',
        args: [{ target: LINK_MOVE_TARGET.session, session_id: session.session_id }],
      });
    });
    expect(agorStore.getState().linksByBranch.get(branch.branch_id)).toBeUndefined();
    expect(agorStore.getState().linksBySession.get(session.session_id)).toEqual([moved]);
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
