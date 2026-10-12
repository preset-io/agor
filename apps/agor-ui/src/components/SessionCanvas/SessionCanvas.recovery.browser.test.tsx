import type { AgorClient, Board, Branch, Repo } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import 'reactflow/dist/style.css';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from '../BoardTeammatePanel';
import { makeTeammateBranch } from '../BranchModal/testUtils';
import SessionCanvas from './SessionCanvas';

afterEach(cleanup);
it('board primary excluded from the canvas still exposes recovery in its panel', async () => {
  const branch = makeTeammateBranch(
    {
      branch_id: 'recovery-primary' as Branch['branch_id'],
      board_id: 'recovery-board' as Branch['board_id'],
      repo_id: 'recovery-repo' as Branch['repo_id'],
      name: 'Recovery teammate' as Branch['name'],
      filesystem_status: 'cleaned',
      archived: false,
    },
    { displayName: 'Recovery teammate' }
  );
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
    compose({
      ...branch,
      filesystem_status: 'failed',
      provisioning_operation: 'create',
      error_message: 'Template fetch failed',
    })
  );
  expect(await screen.findByText(/Ask a workspace admin to check/)).toBeVisible();
  const summary = screen.getByText('Technical details');
  const details = summary.closest('details')!;
  expect(details).not.toHaveAttribute('open');
  await userEvent.click(summary);
  expect(details).toHaveAttribute('open');
  expect((await screen.findAllByText('Template fetch failed'))[0]).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  view.rerender(
    compose({
      ...branch,
      filesystem_status: 'failed',
      provisioning_operation: 'restore',
      error_message: 'Repair Git linkage',
    })
  );
  expect(screen.queryByText('Technical details')).toBeNull();
  expect(screen.queryByText(/Ask a workspace admin to check/)).toBeNull();
  expect((await screen.findAllByText('Repair Git linkage'))[0]).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  view.rerender(compose({ ...branch, filesystem_status: 'ready' }));
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});
