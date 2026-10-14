import type { AgorClient, Board, BoardEntityObject, Branch, Repo } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import 'reactflow/dist/style.css';
import { afterEach, expect, it, vi } from 'vitest';
import { shallow } from 'zustand/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { boardObjectCreated, branchCreated, branchPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { makeBranchesForBoardSelector } from '../../store/selectors';
import { markBoardLoaded } from '../../test/userScopeCoverage';
import SessionCanvas from './SessionCanvas';

afterEach(() => {
  cleanup();
  setRealtimeAuthorityScope(null);
});

it('renders an asynchronously created branch in its zone without remounting the open board', async () => {
  const board = {
    board_id: 'creation-board',
    name: 'Creation fixture',
    archived: false,
    objects: {
      'zone-tasks': {
        type: 'zone',
        x: 100,
        y: 100,
        width: 1400,
        height: 700,
        label: 'Coding Tasks',
      },
    },
  } as unknown as Board;
  const branch = {
    branch_id: 'creation-branch',
    board_id: board.board_id,
    repo_id: 'creation-repo',
    name: 'MCP-created fixture',
    filesystem_status: 'creating',
    archived: false,
  } as Branch;
  const placement = {
    object_id: 'creation-placement',
    board_id: board.board_id,
    branch_id: branch.branch_id,
    entity_type: 'branch',
    zone_id: 'zone-tasks',
    position: { x: 80, y: 120 },
  } as BoardEntityObject;
  const repo = { repo_id: branch.repo_id, slug: 'fixture/realtime' } as Repo;
  agorStore.setState({ ...EMPTY_MAPS, repoById: new Map([[repo.repo_id, repo]]) });
  // The open board's loaded partition holds the rows created on it.
  setRealtimeAuthorityScope('creation-user:member:1');
  markBoardLoaded(board.board_id);
  const client = {
    service: () => ({
      find: async () => ({ data: [], capabilities: [] }),
      get: async () => ({ capabilities: [] }),
      on: vi.fn(),
      off: vi.fn(),
    }),
  } as unknown as AgorClient;
  const select = makeBranchesForBoardSelector(board.board_id);
  function OpenBoard() {
    const branches = useStoreWithEqualityFn(agorStore, select, shallow);
    return <SessionCanvas board={board} branches={branches} client={client} height={700} />;
  }
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
        <div style={{ width: '100%', height: 700 }}>
          <OpenBoard />
        </div>
      </ConnectionProvider>
    </App>
  );
  expect(screen.queryByText(branch.name)).toBeNull();
  await act(async () => branchCreated(branch));
  expect(screen.queryByText(branch.name)).toBeNull(); // branch_id/board_id alone is not placement
  await act(async () => boardObjectCreated(placement));
  await screen.findByText(branch.name);
  const ready = { ...branch, filesystem_status: 'ready' as const };
  await act(async () => {
    branchPatched(ready);
    branchCreated(branch); // delayed duplicate cannot regress readiness
    boardObjectCreated(placement);
  });
  await waitFor(() => {
    const nodes = view.container.querySelectorAll<HTMLElement>(`[data-id="${branch.branch_id}"]`);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].getBoundingClientRect().width).toBeGreaterThan(0);
    // React Flow child coordinates include the zone origin, not a fallback
    // near (0,0): zone (100,100) + relative placement (80,120).
    expect(nodes[0].style.transform.replaceAll(' ', '')).toBe('translate(180px,220px)');
  });
  expect(agorStore.getState().branchById.get(branch.branch_id)?.filesystem_status).toBe('ready');
  expect(agorStore.getState().boardObjectsByBoardId.get(board.board_id)).toEqual([placement]);
});
