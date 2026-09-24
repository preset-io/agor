import type { AgorClient, Board, Branch, Repo } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import 'reactflow/dist/style.css';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from '../BoardTeammatePanel';
import SessionCanvas from './SessionCanvas';

afterEach(cleanup);
it('board primary excluded from the canvas still exposes recovery in its panel', async () => {
  const branch = {
    branch_id: 'recovery-primary',
    board_id: 'recovery-board',
    repo_id: 'recovery-repo',
    name: 'Recovery teammate',
    filesystem_status: 'cleaned',
    archived: false,
    custom_context: { teammate: { kind: 'teammate', displayName: 'Recovery teammate' } },
  } as Branch;
  const board = {
    board_id: branch.board_id,
    name: 'Recovery board',
    primary_teammate_id: branch.branch_id,
    objects: {},
  } as Board;
  const repo = { repo_id: branch.repo_id, slug: 'fixture/recovery' } as Repo;
  agorStore.setState({
    ...EMPTY_MAPS,
    branchById: new Map([[branch.branch_id, branch]]),
    repoById: new Map([[repo.repo_id, repo]]),
  });
  const create = vi.fn().mockResolvedValue({});
  const service = vi.fn(() => ({
    create,
    find: async () => ({ data: [], capabilities: [] }),
    get: async () => ({ capabilities: [] }),
    on: vi.fn(),
    off: vi.fn(),
  }));
  const client = { service } as unknown as AgorClient;
  const compose = (current: Branch) => (
    <App>
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
        <div style={{ height: 250 }}>
          <SessionCanvas
            board={board}
            branches={[current]}
            primaryTeammateId={branch.branch_id}
            client={client}
            height={250}
          />
        </div>
        <BoardTeammatePanel
          board={board}
          primaryTeammateBranch={current}
          primaryTeammateRepo={repo}
          primaryTeammateInaccessible={false}
          onSessionClick={() => {}}
          client={client}
        />
      </ConnectionProvider>
    </App>
  );
  const view = render(compose(branch));
  expect(view.container.querySelector(`[data-id="${branch.branch_id}"]`)).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Recover' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({}));
  expect(service).toHaveBeenCalledWith(`branches/${branch.branch_id}/retry-provisioning`);
  view.rerender(
    compose({ ...branch, filesystem_status: 'creating', provisioning_operation: 'restore' })
  );
  expect(await screen.findByText('Filesystem recovery in progress')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Recover' })).toBeNull();
  view.rerender(
    compose({ ...branch, filesystem_status: 'creating', provisioning_operation: 'create' })
  );
  expect(await screen.findByText('Filesystem provisioning in progress')).toBeVisible();
  expect(screen.queryByText('Filesystem recovery in progress')).toBeNull();
  view.rerender(
    compose({ ...branch, filesystem_status: 'failed', error_message: 'Repair Git linkage' })
  );
  expect((await screen.findAllByText('Repair Git linkage'))[0]).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  view.rerender(compose({ ...branch, filesystem_status: 'ready' }));
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});
