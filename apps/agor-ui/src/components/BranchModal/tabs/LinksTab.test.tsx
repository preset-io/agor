import type { AgorClient, Board, Branch, Link, Session } from '@agor-live/client';
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

function makeClient(args: { branchLinks: Link[]; teammateLinks: Link[]; promoted: Link }) {
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
          return args.promoted;
        },
        async remove(id: string) {
          calls.push({ service: path, method: 'remove', args: [id] });
          return args.promoted;
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

describe('LinksTab teammate promotion actions', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('hydrates branch and teammate links, then promotes a branch link', async () => {
    const source = makeLink();
    const promoted = makeLink({
      link_id: 'teammate-link' as Link['link_id'],
      branch_id: 'teammate-1' as Link['branch_id'],
      is_pinned: true,
      metadata: { teammate_promotion: true },
    });
    seedStore([source]);
    const { client, calls } = makeClient({ branchLinks: [source], teammateLinks: [], promoted });

    renderLinksTab(client);

    await screen.findByText('Runbook');
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.service === 'links' &&
            call.method === 'findAll' &&
            (call.args[0] as { query?: { branch_id?: string } } | undefined)?.query?.branch_id ===
              'teammate-1'
        )
      ).toBe(true)
    );

    fireEvent.click(screen.getByLabelText('Teammate actions for Runbook'));
    fireEvent.click(await screen.findByText('Promote to teammate'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links/link-1/promote',
        method: 'create',
        args: [{ target: 'teammate', teammate_branch_id: 'teammate-1' }],
      });
    });
    expect(agorStore.getState().linksByBranch.get('teammate-1')).toEqual([promoted]);
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
      promoted: pinnedIssue,
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

  it('removes the teammate-owned copy without removing the source link', async () => {
    const source = makeLink();
    const promoted = makeLink({
      link_id: 'teammate-link' as Link['link_id'],
      branch_id: 'teammate-1' as Link['branch_id'],
      is_pinned: true,
      metadata: { teammate_promotion: true },
    });
    seedStore([source], [promoted]);
    const { client, calls } = makeClient({
      branchLinks: [source],
      teammateLinks: [promoted],
      promoted,
    });

    renderLinksTab(client);

    await screen.findByText('Runbook');
    fireEvent.click(screen.getByLabelText('Teammate actions for Runbook'));
    fireEvent.click(await screen.findByText('Remove from teammate'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links',
        method: 'remove',
        args: ['teammate-link'],
      });
    });
    expect(agorStore.getState().linkById.has('teammate-link')).toBe(false);
    expect(agorStore.getState().linkById.has('link-1')).toBe(true);
  });

  it("does not expose promotion removal for a teammate branch's unmarked link", async () => {
    const teammateBranch = { ...branch, branch_id: 'teammate-1' } as Branch;
    const ownedLink = makeLink({
      link_id: 'teammate-link' as Link['link_id'],
      branch_id: 'teammate-1' as Link['branch_id'],
    });
    seedStore([], [ownedLink]);
    const { client, calls } = makeClient({
      branchLinks: [],
      teammateLinks: [ownedLink],
      promoted: ownedLink,
    });

    renderLinksTab(client, teammateBranch);

    await screen.findByText('Runbook');
    expect(screen.queryByLabelText('Teammate actions for Runbook')).not.toBeInTheDocument();
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
      promoted: apiLink,
    });

    renderLinksTab(client);

    await screen.findByText('Runbook');
    expect(await screen.findByText('From Design review')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search links'), { target: { value: 'api' } });

    await waitFor(() => expect(screen.queryByText('Runbook')).toBeNull());
    expect(screen.getByText('API notes')).toBeTruthy();
  });

  it('does not expose manual add-link controls in the branch links tab', async () => {
    seedStore([]);
    const { client } = makeClient({
      branchLinks: [],
      teammateLinks: [],
      promoted: makeLink(),
    });

    renderLinksTab(client);

    expect(screen.queryByRole('button', { name: /add link/i })).toBeNull();
    expect(
      screen.queryByPlaceholderText('https://example.com or agor://kb/team/doc.md')
    ).toBeNull();
    expect(screen.queryByLabelText(/file path/i)).toBeNull();
  });
});
