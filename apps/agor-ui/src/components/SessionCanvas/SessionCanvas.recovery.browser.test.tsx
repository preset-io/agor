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
  expect(
    await screen.findByText(
      "This branch's files aren't available. Restore them to start a session."
    )
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Restore files' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({}));
  expect(service).toHaveBeenCalledWith(`branches/${branch.branch_id}/retry-provisioning`);
  view.rerender(
    compose({ ...branch, filesystem_status: 'creating', provisioning_operation: 'restore' })
  );
  expect(await screen.findByText("Agor is restoring this branch's files…")).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Restore files' })).toBeNull();
  view.rerender(
    compose({ ...branch, filesystem_status: 'creating', provisioning_operation: 'create' })
  );
  expect(await screen.findByText('Agor is setting up this branch…')).toBeVisible();
  expect(screen.queryByText("Agor is restoring this branch's files…")).toBeNull();
  view.rerender(
    compose({
      ...branch,
      filesystem_status: 'failed',
      provisioning_operation: 'create',
      error_message: 'Template fetch failed',
    })
  );
  expect(await screen.findByText("Agor couldn't set up your teammate's workspace.")).toBeVisible();
  expect(screen.queryByText('Template fetch failed')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(await screen.findByText('Template fetch failed')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  view.rerender(
    compose({
      ...branch,
      filesystem_status: 'failed',
      provisioning_operation: 'restore',
      error_message: 'Repair Git linkage',
    })
  );
  expect(await screen.findByText("Agor couldn't restore this branch's files.")).toBeVisible();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  view.rerender(compose({ ...branch, filesystem_status: 'ready' }));
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});
