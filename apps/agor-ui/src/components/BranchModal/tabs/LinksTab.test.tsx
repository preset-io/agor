import type { AgorClient, Board, Branch, Link } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
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
  primary_teammate_id: 'teammate-1',
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
    });
    seedStore([source]);
    const { client, calls } = makeClient({ branchLinks: [source], teammateLinks: [], promoted });

    render(
      <AntApp>
        <LinksTab branch={branch} client={client} active open />
      </AntApp>
    );

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
    fireEvent.click(await screen.findByText('Add to teammate'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        service: 'links/link-1/promote',
        method: 'create',
        args: [{ target: 'teammate', teammate_branch_id: 'teammate-1' }],
      });
    });
    expect(agorStore.getState().linksByBranch.get('teammate-1')).toEqual([promoted]);
  });

  it('removes the teammate-owned copy without removing the source link', async () => {
    const source = makeLink();
    const promoted = makeLink({
      link_id: 'teammate-link' as Link['link_id'],
      branch_id: 'teammate-1' as Link['branch_id'],
      is_pinned: true,
    });
    seedStore([source], [promoted]);
    const { client, calls } = makeClient({
      branchLinks: [source],
      teammateLinks: [promoted],
      promoted,
    });

    render(
      <AntApp>
        <LinksTab branch={branch} client={client} active open />
      </AntApp>
    );

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
});
