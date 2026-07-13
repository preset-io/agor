import type { AgorClient, Board, Branch, Link, LinkMoveResult, Session } from '@agor-live/client';
import { LINK_MOVE_TARGET } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_MAPS } from '../../../store/agorMaps';
import { agorStore } from '../../../store/agorStore';
import { makeTestLink } from '../../Links/testUtils';
import { LinksTab } from './LinksTab';

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  issue_url: null,
  pull_request_url: null,
} as unknown as Branch;

const board = {
  board_id: 'board-1',
  primary_teammate_id: 'teammate-1',
} as unknown as Board;

const makeLink = (overrides: Partial<Link> = {}) =>
  makeTestLink({
    branch_id: 'branch-1',
    session_id: null,
    url: 'https://example.com/runbook',
    title: 'Runbook',
    ...overrides,
  });

function seedStore(branchLinks: Link[], teammateLinks: Link[] = []) {
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([[board.board_id, board]]),
    linksByBranch: new Map([
      ['branch-1', branchLinks],
      ['teammate-1', teammateLinks],
    ]),
    linkById: new Map([...branchLinks, ...teammateLinks].map((link) => [link.link_id, link])),
  });
}

function makeClient(args: {
  branchLinks: Link[];
  teammateLinks: Link[];
  moved: Link;
  materialized?: Link;
  moveResult?: LinkMoveResult;
}) {
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const client = {
    service(path: string) {
      return {
        async findAll(params?: { query?: { branch_id?: string } }) {
          calls.push({ service: path, method: 'findAll', args: [params] });
          if (params?.query?.branch_id === 'teammate-1') return args.teammateLinks;
          return args.branchLinks;
        },
        async create(body: unknown) {
          calls.push({ service: path, method: 'create', args: [body] });
          if (path === 'links' && args.materialized) return args.materialized;
          if (path.endsWith('/move')) {
            return (
              args.moveResult ?? {
                link: args.moved,
                previous_link: args.branchLinks[0] ?? args.materialized,
                merged: false,
              }
            );
          }
          return args.moved;
        },
        async patch(id: string, body: Record<string, unknown>) {
          calls.push({ service: path, method: 'patch', args: [id, body] });
          const existing = [...args.branchLinks, ...args.teammateLinks].find(
            (link) => link.link_id === id
          );
          return { ...existing, ...body };
        },
        async remove(id: string) {
          calls.push({ service: path, method: 'remove', args: [id] });
          return args.moved;
        },
      };
    },
  } as unknown as AgorClient;
  return { client, calls };
}

function renderLinksTab(client: AgorClient, targetBranch: Branch = branch) {
  return render(
    <MemoryRouter>
      <AntApp>
        <LinksTab branch={targetBranch} client={client} active open />
      </AntApp>
    </MemoryRouter>
  );
}

describe('LinksTab move actions', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('hydrates branch links, then moves a branch link to the teammate', async () => {
    const source = makeLink();
    const moved = makeLink({
      branch_id: 'teammate-1' as Link['branch_id'],
      is_pinned: true,
      revision: (source.revision ?? 1) + 1,
    });
    seedStore([source]);
    const { client, calls } = makeClient({ branchLinks: [source], teammateLinks: [], moved });

    renderLinksTab(client);

    await screen.findByText('Runbook');

    fireEvent.click(screen.getByLabelText('Actions for Runbook'));
    fireEvent.click(await screen.findByText('Move to teammate'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links/link-1/move',
        method: 'create',
        args: [{ target: LINK_MOVE_TARGET.branch, branch_id: 'teammate-1' }],
      });
    });
    expect(agorStore.getState().linksByBranch.get(branch.branch_id)).toBeUndefined();
    expect(agorStore.getState().linkById.get(source.link_id)).toEqual(moved);
    expect(agorStore.getState().linksByBranch.get('teammate-1')).toEqual([moved]);
  });

  it('adds a newly materialized branch pin to the store immediately', async () => {
    const branchWithIssue = {
      ...branch,
      issue_url: 'https://github.com/preset-io/agor/issues/154',
    } as Branch;
    const pinnedIssue = makeLink({
      link_id: 'issue-link' as Link['link_id'],
      kind: 'issue',
      title: 'preset-io/agor#154',
      url: branchWithIssue.issue_url,
      target_key: 'url:https://github.com/preset-io/agor/issues/154',
      is_pinned: true,
    });
    seedStore([]);
    const { client, calls } = makeClient({
      branchLinks: [],
      teammateLinks: [],
      moved: pinnedIssue,
    });

    renderLinksTab(client, branchWithIssue);

    fireEvent.click(await screen.findByRole('button', { name: 'Pin preset-io/agor#154' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        service: 'links',
        method: 'create',
        args: [expect.objectContaining({ is_pinned: true, url: branchWithIssue.issue_url })],
      })
    );
    expect(agorStore.getState().linkById.get(pinnedIssue.link_id)).toEqual(pinnedIssue);
    expect(
      agorStore
        .getState()
        .linksByBranch.get(branch.branch_id)
        ?.some((link) => link.link_id === pinnedIssue.link_id && link.is_pinned)
    ).toBe(true);
  });

  it('materializes generated branch metadata before moving it to a teammate', async () => {
    const branchWithIssue = {
      ...branch,
      issue_url: 'https://github.com/preset-io/agor/issues/154',
    } as Branch;
    const materialized = makeLink({
      link_id: 'issue-source' as Link['link_id'],
      kind: 'issue',
      url: branchWithIssue.issue_url,
      target_key: 'url:https://github.com/preset-io/agor/issues/154',
    });
    const moved = makeLink({
      ...materialized,
      branch_id: 'teammate-1' as Link['branch_id'],
      session_id: null,
      revision: (materialized.revision ?? 1) + 1,
    });
    seedStore([]);
    const { client, calls } = makeClient({
      branchLinks: [],
      teammateLinks: [],
      materialized,
      moved,
    });

    renderLinksTab(client, branchWithIssue);

    fireEvent.click(await screen.findByLabelText('Actions for Issue: preset-io/agor#154'));
    fireEvent.click(await screen.findByText('Move to teammate'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links',
        method: 'create',
        args: [expect.objectContaining({ url: branchWithIssue.issue_url, is_pinned: false })],
      });
      expect(calls).toContainEqual({
        service: 'links/issue-source/move',
        method: 'create',
        args: [{ target: LINK_MOVE_TARGET.branch, branch_id: 'teammate-1' }],
      });
    });
  });

  it('coalesces a move into an existing teammate destination', async () => {
    const source = makeLink();
    const destination = makeLink({
      link_id: 'teammate-link' as Link['link_id'],
      branch_id: 'teammate-1' as Link['branch_id'],
      is_pinned: true,
    });
    seedStore([source], [destination]);
    const { client, calls } = makeClient({
      branchLinks: [source],
      teammateLinks: [destination],
      moved: destination,
      moveResult: { link: destination, previous_link: source, merged: true },
    });

    renderLinksTab(client);

    await screen.findByText('Runbook');
    fireEvent.click(screen.getByLabelText('Actions for Runbook'));
    fireEvent.click(await screen.findByText('Move to teammate'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links/link-1/move',
        method: 'create',
        args: [{ target: LINK_MOVE_TARGET.branch, branch_id: 'teammate-1' }],
      });
    });
    expect(agorStore.getState().linkById.has(source.link_id)).toBe(false);
    expect(agorStore.getState().linkById.get(destination.link_id)).toEqual(destination);
  });

  it('omits the current teammate owner instead of rendering a disabled action', async () => {
    const teammateBranch = { ...branch, branch_id: 'teammate-1' } as Branch;
    const ownedLink = makeLink({
      link_id: 'teammate-link' as Link['link_id'],
      branch_id: 'teammate-1' as Link['branch_id'],
    });
    seedStore([], [ownedLink]);
    const { client, calls } = makeClient({
      branchLinks: [],
      teammateLinks: [ownedLink],
      moved: ownedLink,
    });

    renderLinksTab(client, teammateBranch);

    await screen.findByText('Runbook');
    fireEvent.click(screen.getByLabelText('Actions for Runbook'));
    expect(screen.queryByText(/already (saved|moved)/i)).toBeNull();
    expect(screen.queryByText(/move to/i)).toBeNull();
    expect(calls.some((call) => call.method === 'remove')).toBe(false);
    expect(agorStore.getState().linkById.has('teammate-link')).toBe(true);
  });

  it('searches links and shows source session attribution from the centralized store', async () => {
    const sourceSession = {
      session_id: 'session-source-1',
      title: 'Design review',
    } as unknown as Session;
    const runbook = makeLink();
    const apiLink = makeLink({
      link_id: 'link-api' as Link['link_id'],
      title: 'API notes',
      url: 'https://example.com/api',
      target_key: 'url:https://example.com/api',
      metadata: { promoted_from_owner: { session_id: sourceSession.session_id } },
    });
    seedStore([runbook, apiLink]);
    agorStore.setState((state) => ({
      ...state,
      sessionById: new Map([[sourceSession.session_id, sourceSession]]),
    }));
    const { client } = makeClient({
      branchLinks: [runbook, apiLink],
      teammateLinks: [],
      moved: apiLink,
    });

    renderLinksTab(client);

    await screen.findByText('Runbook');
    expect(await screen.findByText('From Design review')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search links'), { target: { value: 'api' } });

    await waitFor(() => expect(screen.queryByText('Runbook')).toBeNull());
    expect(screen.getByText('API notes')).toBeTruthy();
  });

  it('opens the shared manual add-link editor from an empty branch', async () => {
    seedStore([]);
    const { client, calls } = makeClient({
      branchLinks: [],
      teammateLinks: [],
      moved: makeLink(),
    });

    renderLinksTab(client);

    fireEvent.click(screen.getByRole('button', { name: /add link/i }));
    expect(await screen.findByRole('dialog', { name: 'Add link' })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('https://example.com or agor://kb/team/document.md')
    ).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Optional display label'), {
      target: { value: 'Architecture' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('https://example.com or agor://kb/team/document.md'),
      { target: { value: 'https://example.com/architecture' } }
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Add link' }).at(-1)!);

    await waitFor(() =>
      expect(calls).toContainEqual({
        service: 'links',
        method: 'create',
        args: [
          expect.objectContaining({
            branch_id: 'branch-1',
            title: 'Architecture',
            url: 'https://example.com/architecture',
          }),
        ],
      })
    );
    expect(screen.queryByLabelText(/file path/i)).toBeNull();
  });
});
