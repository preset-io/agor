import type { AgorClient, Board, BoardEntityObject, Branch, Repo, User } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import 'reactflow/dist/style.css';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { boardObjectPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import SessionCanvas from './SessionCanvas';

afterEach(cleanup);

it('persists two real pointer drags when the first PATCH completes during the second debounce', async () => {
  const user = { user_id: 'placement-owner', role: 'member' } as User;
  const board = {
    board_id: 'placement-browser-board',
    name: 'Placement browser fixture',
    objects: {},
    primary_owner_user_id: user.user_id,
  } as Board;
  const branch = {
    branch_id: 'placement-browser-branch',
    board_id: board.board_id,
    name: 'Drag regression branch',
    repo_id: 'placement-repo',
    filesystem_status: 'ready',
    archived: false,
  } as Branch;
  const repo = { repo_id: branch.repo_id, slug: 'fixture/placement' } as Repo;
  const initial = {
    object_id: 'placement-browser-object',
    board_id: board.board_id,
    branch_id: branch.branch_id,
    entity_type: 'branch',
    position: { x: 0, y: 0 },
  } as BoardEntityObject;
  agorStore.setState({
    ...EMPTY_MAPS,
    userById: new Map([[user.user_id, user]]),
    branchById: new Map([[branch.branch_id, branch]]),
    repoById: new Map([[repo.repo_id, repo]]),
    boardObjectsByBoardId: new Map([[board.board_id, [initial]]]),
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const patch = vi.fn(async (_id: string, data: Partial<BoardEntityObject>) => {
    if (patch.mock.calls.length === 1) await pending;
    const result = { ...initial, ...data };
    boardObjectPatched(result);
    return result;
  });
  const client = {
    service: () => ({
      patch,
      find: async () => ({ data: [], capabilities: [] }),
      get: async () => ({ capabilities: [] }),
      on: vi.fn(),
      off: vi.fn(),
    }),
  } as unknown as AgorClient;
  const view = render(
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
        <div style={{ width: '100%', height: 500 }}>
          <SessionCanvas
            board={board}
            branches={[branch]}
            client={client}
            currentUserId={user.user_id}
            height={500}
          />
        </div>
      </ConnectionProvider>
    </App>
  );
  const title = await screen.findByText(branch.name);
  const node = view.container.querySelector<HTMLElement>(`[data-id="${branch.branch_id}"]`)!;
  const pane = view.container.querySelector<HTMLElement>('.react-flow__pane')!;
  await waitFor(() => expect(node.classList.contains('nopan')).toBe(true));
  // Let the production 100ms fit-view + 200ms animation settle before pointer input.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  const drag = async (fraction: number) => {
    await act(async () =>
      userEvent.dragAndDrop(title, pane, {
        targetPosition: { x: pane.clientWidth * fraction, y: 180 },
      })
    );
  };
  await drag(0.6);
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  await drag(0.8);
  const transform = node.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
  expect(transform).not.toBeNull();
  const expected = { x: Number(transform![1]), y: Number(transform![2]) };
  expect(expected).not.toEqual(patch.mock.calls[0][1].position);
  await act(async () => release());
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][1].position).toEqual(expected);
  expect(agorStore.getState().boardObjectsByBoardId.get(board.board_id)?.[0].position).toEqual(
    expected
  );
  await waitFor(() =>
    expect(node.style.transform).toBe(`translate(${expected.x}px, ${expected.y}px)`)
  );
});
