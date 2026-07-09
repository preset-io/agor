import type { AgorClient, Board, Branch, Link, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_MAPS } from '../../../store/agorMaps';
import { agorStore } from '../../../store/agorStore';
import { LinksTab } from './LinksTab';

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  issue_url: null,
  pull_request_url: null,
} as unknown as Branch;

const board = {
  board_id: 'board-1',
  primary_assistant_id: 'assistant-1',
} as unknown as Board;

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    link_id: 'link-1',
    branch_id: 'branch-1',
    session_id: null,
    source_message_id: null,
    kind: 'url',
    source: 'manual',
    url: 'https://example.com/runbook',
    ref_uri: null,
    file_path: null,
    target_key: 'url:https://example.com/runbook',
    is_pinned: false,
    title: 'Runbook',
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as Link;
}

function seedStore(branchLinks: Link[], assistantLinks: Link[] = []) {
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([[board.board_id, board]]),
    linksByBranch: new Map([
      ['branch-1', branchLinks],
      ['assistant-1', assistantLinks],
    ]),
    linkById: new Map([...branchLinks, ...assistantLinks].map((link) => [link.link_id, link])),
  });
}

function makeClient(args: { branchLinks: Link[]; assistantLinks: Link[]; promoted: Link }) {
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const client = {
    service(path: string) {
      return {
        async findAll(params?: { query?: { branch_id?: string } }) {
          calls.push({ service: path, method: 'findAll', args: [params] });
          if (params?.query?.branch_id === 'assistant-1') return args.assistantLinks;
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

describe('LinksTab assistant promotion actions', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('hydrates branch and assistant links, then promotes a branch link', async () => {
    const source = makeLink();
    const promoted = makeLink({
      link_id: 'assistant-link' as Link['link_id'],
      branch_id: 'assistant-1' as Link['branch_id'],
      is_pinned: true,
    });
    seedStore([source]);
    const { client, calls } = makeClient({ branchLinks: [source], assistantLinks: [], promoted });

    render(
      <MemoryRouter>
        <AntApp>
          <LinksTab branch={branch} client={client} active open />
        </AntApp>
      </MemoryRouter>
    );

    await screen.findByText('Runbook');
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.service === 'links' &&
            call.method === 'findAll' &&
            (call.args[0] as { query?: { branch_id?: string } } | undefined)?.query?.branch_id ===
              'assistant-1'
        )
      ).toBe(true)
    );

    fireEvent.click(screen.getByLabelText('Assistant actions for Runbook'));
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

  it('removes the assistant-owned copy without removing the source link', async () => {
    const source = makeLink();
    const promoted = makeLink({
      link_id: 'assistant-link' as Link['link_id'],
      branch_id: 'assistant-1' as Link['branch_id'],
      is_pinned: true,
    });
    seedStore([source], [promoted]);
    const { client, calls } = makeClient({
      branchLinks: [source],
      assistantLinks: [promoted],
      promoted,
    });

    render(
      <MemoryRouter>
        <AntApp>
          <LinksTab branch={branch} client={client} active open />
        </AntApp>
      </MemoryRouter>
    );

    await screen.findByText('Runbook');
    fireEvent.click(screen.getByLabelText('Assistant actions for Runbook'));
    fireEvent.click(await screen.findByText('Remove from assistant'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links',
        method: 'remove',
        args: ['assistant-link'],
      });
    });
    expect(agorStore.getState().linkById.has('assistant-link')).toBe(false);
    expect(agorStore.getState().linkById.has('link-1')).toBe(true);
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
      assistantLinks: [],
      promoted: apiLink,
    });

    render(
      <MemoryRouter>
        <AntApp>
          <LinksTab branch={branch} client={client} active open />
        </AntApp>
      </MemoryRouter>
    );

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
      assistantLinks: [],
      promoted: makeLink(),
    });

    render(
      <MemoryRouter>
        <AntApp>
          <LinksTab branch={branch} client={client} active open />
        </AntApp>
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /add link/i })).toBeNull();
    expect(
      screen.queryByPlaceholderText('https://example.com or agor://kb/team/doc.md')
    ).toBeNull();
    expect(screen.queryByLabelText(/file path/i)).toBeNull();
  });
});
