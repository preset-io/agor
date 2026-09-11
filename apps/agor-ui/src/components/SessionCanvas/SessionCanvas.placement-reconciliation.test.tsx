import type {
  AgorClient,
  Board,
  BoardEntityObject,
  Branch,
  CardWithType,
  Repo,
  Session,
} from '@agor-live/client';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { boardObjectPatched, sessionPatched } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import SessionCanvas from './SessionCanvas';

interface FlowNode {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  positionAbsolute?: { x: number; y: number };
  width?: number;
  height?: number;
  zIndex?: number;
}

interface CapturedFlowProps {
  nodes: FlowNode[];
  onNodeDragStart?: (event: unknown, node: FlowNode) => void;
  onNodeDrag?: (event: unknown, node: FlowNode) => void;
  onNodeDragStop?: (event: unknown, node: FlowNode) => void;
}

let flowProps: CapturedFlowProps | null = null;

vi.mock('reactflow', async () => {
  const React = await import('react');
  return {
    Background: () => null,
    Controls: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ControlButton: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    MiniMap: () => null,
    ReactFlow: (
      props: CapturedFlowProps & { children?: ReactNode; onInit?: (value: unknown) => void }
    ) => {
      flowProps = props;
      React.useEffect(() => {
        props.onInit?.({
          fitView: vi.fn(),
          getNode: (id: string) => flowProps?.nodes.find((node) => node.id === id),
          getNodes: () => flowProps?.nodes ?? [],
          getZoom: () => 1,
          screenToFlowPosition: (position: { x: number; y: number }) => position,
        });
      }, []);
      return <div data-testid="react-flow">{props.children}</div>;
    },
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useNodesState: (initial: FlowNode[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = React.useState(initial);
      return [edges, setEdges, vi.fn()];
    },
  };
});

vi.mock('../BranchCard', () => ({
  __esModule: true,
  default: () => <div />,
}));

vi.mock('./canvas/ZoneTriggerModal', () => ({
  ZoneTriggerModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="zone-trigger-picker" /> : null,
}));

const BOARD_ID = 'board-placement-fixture';
const BRANCH_ID = 'branch-example-feature';
const IMPLEMENTING_ZONE_ID = 'zone-implementing';
const REVIEWING_ZONE_ID = 'zone-reviewing';

const branch = {
  branch_id: BRANCH_ID,
  repo_id: 'repo-1',
  board_id: BOARD_ID,
  name: 'example-feature',
  archived: false,
} as unknown as Branch;

const repo = {
  repo_id: 'repo-1',
  name: 'example',
  slug: 'example/project',
} as unknown as Repo;

const board = {
  board_id: BOARD_ID,
  name: 'Disposable placement geometry fixture',
  objects: {
    [IMPLEMENTING_ZONE_ID]: {
      type: 'zone',
      x: 1740,
      y: 80,
      width: 1100,
      height: 720,
      label: 'Implementing',
    },
    [REVIEWING_ZONE_ID]: {
      type: 'zone',
      x: 2890,
      y: 80,
      width: 740,
      height: 720,
      label: 'Reviewing',
    },
    'artifact-large': {
      type: 'artifact',
      x: 1600,
      y: 1320,
      width: 1800,
      height: 1000,
      artifact_id: 'artifact-1',
    },
  },
  created_at: '2026-09-01T00:00:00.000Z',
  last_updated: '2026-09-01T00:00:00.000Z',
  created_by: 'user-1',
  url: 'http://localhost/ui/b/example/',
  archived: false,
} as unknown as Board;

const implementingPlacement = {
  object_id: 'board-object-branch',
  board_id: BOARD_ID,
  branch_id: BRANCH_ID,
  entity_type: 'branch',
  zone_id: IMPLEMENTING_ZONE_ID,
  position: { x: 20, y: 100 },
  size: { width: 500, height: 180 },
} as unknown as BoardEntityObject;

const card = {
  card_id: 'card-1',
  board_id: BOARD_ID,
  title: 'Independent pending placement',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  archived: false,
} as unknown as CardWithType;

const reviewingCardPlacement = {
  object_id: 'board-object-card',
  board_id: BOARD_ID,
  card_id: card.card_id,
  entity_type: 'card',
  zone_id: REVIEWING_ZONE_ID,
  position: { x: 80, y: 480 },
  size: { width: 380, height: 120 },
} as unknown as BoardEntityObject;

const connected = {
  authGeneration: 1,
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

function currentNode(id: string): FlowNode {
  const node = flowProps?.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Missing React Flow node ${id}`);
  return node;
}

describe('SessionCanvas authoritative zone placement reconciliation', () => {
  beforeEach(() => {
    flowProps = null;
    agorStore.setState({
      ...EMPTY_MAPS,
      repoById: new Map([[repo.repo_id, repo]]),
      branchById: new Map([[BRANCH_ID, branch]]),
      cardById: new Map([[card.card_id, card]]),
      boardObjectsByBoardId: new Map([[BOARD_ID, [implementingPlacement, reviewingCardPlacement]]]),
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('persists a second drag after the first pending PATCH is acknowledged', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const patch = vi.fn(async (_id: string, data: Partial<BoardEntityObject>) => {
      if (patch.mock.calls.length === 1) await pending;
      const result = { ...implementingPlacement, ...data };
      boardObjectPatched(result);
      return result;
    });
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    render(
      <ConnectionProvider value={connected}>
        <SessionCanvas board={board} client={client} branches={[branch]} />
      </ConnectionProvider>
    );
    await act(async () => {});
    const drag = (x: number) =>
      act(() => {
        const node = { ...currentNode(BRANCH_ID), positionAbsolute: { x, y: 200 } };
        flowProps?.onNodeDragStart?.({}, node);
        flowProps?.onNodeDrag?.({}, node);
        flowProps?.onNodeDragStop?.({}, node);
      });
    drag(1800);
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(patch).toHaveBeenCalledTimes(1);
    drag(1900);
    await act(async () => {
      release();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1][1]).toMatchObject({
      position: { x: 160, y: 120 },
      zone_id: IMPLEMENTING_ZONE_ID,
    });
    expect(
      agorStore
        .getState()
        .boardObjectsByBoardId.get(BOARD_ID)
        ?.find((row) => row.branch_id === BRANCH_ID)?.position
    ).toEqual({ x: 160, y: 120 });
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: IMPLEMENTING_ZONE_ID,
      position: { x: 160, y: 120 },
    });
  });

  it.each(
    ['branch', 'card'].flatMap((entity) =>
      [false, true].flatMap((drained) =>
        ['before-http', 'after-http'].flatMap((ack) =>
          [false, true].map((crossZone) => ({ entity, drained, ack, crossZone }))
        )
      )
    )
  )(
    'preserves $entity newer intent (drained=$drained, ack=$ack, crossZone=$crossZone)',
    async ({ entity, drained, ack, crossZone }) => {
      vi.useFakeTimers();
      const initial = entity === 'branch' ? implementingPlacement : reviewingCardPlacement;
      const nodeId = entity === 'branch' ? BRANCH_ID : `card-${card.card_id}`;
      const requests: Array<{ result: BoardEntityObject; release: () => void }> = [];
      const patch = vi.fn(
        (_id: string, data: Partial<BoardEntityObject>) =>
          new Promise<BoardEntityObject>((resolve) => {
            const result = { ...initial, ...data };
            requests.push({ result, release: () => resolve(result) });
          })
      );
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      render(
        <ConnectionProvider value={connected}>
          <SessionCanvas board={board} client={client} branches={[branch]} />
        </ConnectionProvider>
      );
      await act(async () => {});
      const drag = (x: number) =>
        act(() => {
          const node = { ...currentNode(nodeId), positionAbsolute: { x, y: 200 } };
          flowProps?.onNodeDragStart?.({}, node);
          flowProps?.onNodeDrag?.({}, node);
          flowProps?.onNodeDragStop?.({}, node);
        });
      const firstX = entity === 'branch' ? 1800 : 3000;
      const secondX = crossZone ? (entity === 'branch' ? 3000 : 1800) : firstX + 100;
      drag(firstX);
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      expect(patch).toHaveBeenCalledTimes(1);
      drag(secondX);
      if (drained)
        await act(async () => {
          vi.advanceTimersByTime(501);
        });
      // A second timer may have drained, but it must not overtake this node's HTTP write.
      expect(patch).toHaveBeenCalledTimes(1);
      if (ack === 'before-http') act(() => boardObjectPatched(requests[0].result));
      await act(async () => requests[0].release());
      if (ack === 'after-http') act(() => boardObjectPatched(requests[0].result));
      if (!drained)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(501);
        });
      expect(patch).toHaveBeenCalledTimes(2);
      const zoneId = secondX < 2800 ? IMPLEMENTING_ZONE_ID : REVIEWING_ZONE_ID;
      const expected = { x: secondX - (zoneId === IMPLEMENTING_ZONE_ID ? 1740 : 2890), y: 120 };
      expect(requests[1].result).toMatchObject({ position: expected, zone_id: zoneId });
      expect(requests[1].result.placement_write_id).not.toBe(requests[0].result.placement_write_id);
      await act(async () => {
        boardObjectPatched(requests[1].result);
        requests[1].release();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(patch).toHaveBeenCalledTimes(2);
      expect(
        agorStore
          .getState()
          .boardObjectsByBoardId.get(BOARD_ID)
          ?.find((row) => row.object_id === initial.object_id)
      ).toMatchObject({ position: expected, zone_id: zoneId });
      expect(currentNode(nodeId)).toMatchObject({ position: expected, parentId: zoneId });
    }
  );

  it.each([
    'external',
    'external-aba',
    'external-matches-inflight',
    'board-switch',
    'auth-switch',
    'unmount',
    'rapid-reordered',
  ])('fences overlapping drained writes after %s', async (change) => {
    vi.useFakeTimers();
    const requests: Array<{ result: BoardEntityObject; release: () => void }> = [];
    const patch = vi.fn(
      (_id: string, data: Partial<BoardEntityObject>) =>
        new Promise<BoardEntityObject>((resolve) => {
          const result = { ...implementingPlacement, ...data };
          requests.push({ result, release: () => resolve(result) });
        })
    );
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const canvas = (nextBoard = board, generation = 1) => (
      <ConnectionProvider value={{ ...connected, authGeneration: generation }}>
        <SessionCanvas board={nextBoard} client={client} branches={[branch]} />
      </ConnectionProvider>
    );
    const view = render(canvas());
    await act(async () => {});
    const drag = (x: number) =>
      act(() => {
        const node = { ...currentNode(BRANCH_ID), positionAbsolute: { x, y: 200 } };
        flowProps?.onNodeDragStart?.({}, node);
        flowProps?.onNodeDrag?.({}, node);
        flowProps?.onNodeDragStop?.({}, node);
      });
    drag(1800);
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    drag(1900);
    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(patch).toHaveBeenCalledTimes(1);
    if (change === 'rapid-reordered') {
      // Coalesce multiple already-drained and still-pending generations, including ABA.
      drag(1800);
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      drag(2000);
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      await act(async () => requests[0].release()); // HTTP before its event
      expect(patch).toHaveBeenCalledTimes(2);
      expect(requests[1].result.position).toEqual({ x: 260, y: 120 });
      drag(2100);
      act(() => boardObjectPatched(requests[1].result));
      act(() => boardObjectPatched(requests[0].result)); // old event arrives last
      await act(async () => requests[1].release());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(501);
      });
      expect(patch).toHaveBeenCalledTimes(3);
      expect(requests[2].result.position).toEqual({ x: 360, y: 120 });
      await act(async () => {
        boardObjectPatched(requests[2].result);
        requests[2].release();
      });
      expect(currentNode(BRANCH_ID).position).toEqual({ x: 360, y: 120 });
    } else {
      if (change.startsWith('external'))
        act(() => {
          boardObjectPatched({
            ...implementingPlacement,
            position:
              change === 'external-matches-inflight'
                ? requests[0].result.position
                : { x: 400, y: 300 },
          });
          if (change === 'external-aba') boardObjectPatched(implementingPlacement);
        });
      else if (change === 'board-switch')
        view.rerender(canvas({ ...board, board_id: 'other-board' } as Board));
      else if (change === 'auth-switch') view.rerender(canvas(board, 2));
      else view.unmount();
      // Neither an old success nor its late realtime echo may resurrect invalidated work.
      await act(async () => {
        boardObjectPatched(requests[0].result);
        requests[0].release();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(patch).toHaveBeenCalledTimes(1);
    }
  });

  it.each([false, true])(
    'bases a newer drag on live authority before React renders (initially unplaced=%s)',
    async (unplaced) => {
      vi.useFakeTimers();
      if (unplaced)
        agorStore.setState({
          boardObjectsByBoardId: new Map([[BOARD_ID, [reviewingCardPlacement]]]),
        });
      const patch = vi.fn(async (_id: string, data: Partial<BoardEntityObject>) => {
        const result = { ...implementingPlacement, ...data };
        boardObjectPatched(result);
        return result;
      });
      const client = { service: () => ({ patch }) } as unknown as AgorClient;
      render(
        <ConnectionProvider value={connected}>
          <SessionCanvas board={board} client={client} branches={[branch]} />
        </ConnectionProvider>
      );
      await act(async () => {});
      const beforeRender = flowProps!;
      const node = { ...currentNode(BRANCH_ID), positionAbsolute: { x: 1900, y: 200 } };
      act(() => {
        boardObjectPatched({ ...implementingPlacement, position: { x: 400, y: 300 } });
        beforeRender.onNodeDragStart?.({}, node);
        beforeRender.onNodeDrag?.({}, node);
        beforeRender.onNodeDragStop?.({}, node);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(501);
      });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch.mock.calls[0][1].position).toEqual({ x: 160, y: 120 });
      expect(currentNode(BRANCH_ID).position).toEqual({ x: 160, y: 120 });
    }
  );

  it('does not persist a stale drag after cross-zone authority advances', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;

    render(
      <ConnectionProvider value={connected}>
        <SessionCanvas board={board} client={client} branches={[branch]} />
      </ConnectionProvider>
    );
    await act(async () => {});

    const staleBranchNode = {
      ...currentNode(BRANCH_ID),
      position: { x: 60, y: 1240 },
      positionAbsolute: { x: 1800, y: 1320 },
      width: 500,
      height: 180,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, staleBranchNode);
      flowProps?.onNodeDrag?.({}, staleBranchNode);
      flowProps?.onNodeDragStop?.({}, staleBranchNode);
    });

    // Queue an unrelated, valid card write after the branch. Both entries use
    // the production shared debounce, so reconciliation must invalidate only
    // the superseded branch entry.
    const validCardNode = {
      ...currentNode(`card-${card.card_id}`),
      position: { x: 120, y: 400 },
      positionAbsolute: { x: 3010, y: 480 },
      width: 380,
      height: 120,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, validCardNode);
      flowProps?.onNodeDrag?.({}, validCardNode);
      flowProps?.onNodeDragStop?.({}, validCardNode);
    });

    act(() =>
      boardObjectPatched({
        ...implementingPlacement,
        zone_id: REVIEWING_ZONE_ID,
        position: { x: 20, y: 100 },
      })
    );
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith('board-object-card', {
      placement_write_id: expect.any(String),
      position: { x: 120, y: 400 },
      zone_id: REVIEWING_ZONE_ID,
    });
    expect(patch).not.toHaveBeenCalledWith('board-object-branch', expect.anything());
  });

  it.each([IMPLEMENTING_ZONE_ID, REVIEWING_ZONE_ID, 'context-replaced', 'new-placement'])(
    'discards a drained branch write when authority advances to %s while another PATCH awaits',
    async (zoneId) => {
      vi.useFakeTimers();
      if (zoneId === 'new-placement') {
        agorStore.setState({
          boardObjectsByBoardId: new Map([[BOARD_ID, [reviewingCardPlacement]]]),
        });
      }
      const expectedZoneId = zoneId === 'new-placement' ? REVIEWING_ZONE_ID : zoneId;
      let releaseCard!: () => void;
      const cardPending = new Promise<void>((resolve) => {
        releaseCard = resolve;
      });
      const patch = vi.fn((id: string) =>
        id === reviewingCardPlacement.object_id ? cardPending : Promise.resolve()
      );
      const create = vi.fn().mockResolvedValue({});
      const client = { service: vi.fn(() => ({ patch, create })) } as unknown as AgorClient;
      render(
        <ConnectionProvider value={connected}>
          <SessionCanvas board={board} client={client} branches={[branch]} />
        </ConnectionProvider>
      );
      await act(async () => {});
      for (const node of [
        {
          ...currentNode(BRANCH_ID),
          positionAbsolute: { x: 1800, y: 200 },
        },
        {
          ...currentNode(`card-${card.card_id}`),
          positionAbsolute: { x: 3010, y: 480 },
        },
      ]) {
        act(() => {
          flowProps?.onNodeDragStart?.({}, node);
          flowProps?.onNodeDrag?.({}, node);
          flowProps?.onNodeDragStop?.({}, node);
        });
      }
      // The timer has drained its ref into a private batch. The card PATCH
      // suspends that batch before the accumulated branch PATCH is sent.
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      expect(patch).toHaveBeenCalledTimes(1);
      act(() => {
        if (zoneId === 'context-replaced') {
          // A new tenant/board context has no authority for this old object.
          agorStore.setState({ boardObjectsByBoardId: new Map() });
        } else {
          boardObjectPatched({
            ...implementingPlacement,
            zone_id: expectedZoneId,
            position: { x: 40, y: 260 },
          });
        }
      });
      await act(async () => {
        releaseCard();
      });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      if (zoneId !== 'context-replaced') {
        expect(currentNode(BRANCH_ID)).toMatchObject({
          parentId: expectedZoneId,
          position: { x: 40, y: 260 },
        });
      }
    }
  );

  it.each(
    (['always_new', 'show_picker'] as const).flatMap((behavior) =>
      ['board-switch', 'placement-changed', 'new-placement', 'unchanged'].map((change) => ({
        behavior,
        change,
      }))
    )
  )(
    'rechecks $behavior trigger and placement authority after $change while a batch suspends',
    async ({ behavior, change }) => {
      vi.useFakeTimers();
      const initiallyPlaced = change !== 'new-placement';
      const unpinned = { ...implementingPlacement, zone_id: null };
      agorStore.setState({
        boardObjectsByBoardId: new Map([
          [BOARD_ID, [reviewingCardPlacement, ...(initiallyPlaced ? [unpinned] : [])]],
        ]),
      });
      const triggerBoard = {
        ...board,
        objects: {
          ...board.objects,
          [IMPLEMENTING_ZONE_ID]: {
            ...board.objects?.[IMPLEMENTING_ZONE_ID],
            trigger: { behavior, prompt_template: 'Review this fictional fixture.' },
          },
        },
      } as Board;
      let releaseCard!: () => void;
      const cardPending = new Promise<void>((resolve) => {
        releaseCard = resolve;
      });
      const patch = vi.fn((id: string) =>
        id === reviewingCardPlacement.object_id ? cardPending : Promise.resolve()
      );
      const create = vi.fn().mockResolvedValue({});
      const client = { service: vi.fn(() => ({ patch, create })) } as unknown as AgorClient;
      const view = render(
        <ConnectionProvider value={connected}>
          <SessionCanvas board={triggerBoard} client={client} branches={[branch]} />
        </ConnectionProvider>
      );
      await act(async () => {});
      // Put the card first, so its PATCH suspends before branch trigger handling.
      for (const node of [
        { ...currentNode(`card-${card.card_id}`), positionAbsolute: { x: 3010, y: 480 } },
        { ...currentNode(BRANCH_ID), positionAbsolute: { x: 1800, y: 200 } },
      ]) {
        act(() => {
          flowProps?.onNodeDragStart?.({}, node);
          flowProps?.onNodeDrag?.({}, node);
          flowProps?.onNodeDragStop?.({}, node);
        });
      }
      await act(async () => {
        vi.advanceTimersByTime(501);
      });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      if (change === 'board-switch') {
        // The old unpinned row remains cached and compares equal unless board
        // identity is explicitly checked. No zone frame can detect this.
        view.rerender(
          <ConnectionProvider value={connected}>
            <SessionCanvas
              board={{ ...triggerBoard, board_id: 'board-other' } as Board}
              client={client}
              branches={[branch]}
            />
          </ConnectionProvider>
        );
      } else if (change !== 'unchanged') {
        act(() =>
          boardObjectPatched({
            ...implementingPlacement,
            zone_id: REVIEWING_ZONE_ID,
            position: { x: 40, y: 260 },
          })
        );
      }
      await act(async () => {
        releaseCard();
      });
      if (change === 'unchanged') {
        expect(patch).toHaveBeenCalledTimes(2);
        if (behavior === 'always_new') expect(create).toHaveBeenCalledTimes(1);
        else expect(screen.getByTestId('zone-trigger-picker')).toBeTruthy();
      } else {
        expect(patch, change).toHaveBeenCalledTimes(1);
        expect(create, change).not.toHaveBeenCalled();
        expect(screen.queryByTestId('zone-trigger-picker'), change).toBeNull();
      }
      view.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  );

  it('preserves relative placement when the parent zone moves during a queued drag', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const view = render(
      <ConnectionProvider value={connected}>
        <SessionCanvas board={board} client={client} branches={[branch]} />
      </ConnectionProvider>
    );
    await act(async () => {});
    const node = { ...currentNode(BRANCH_ID), positionAbsolute: { x: 1800, y: 200 } };
    act(() => {
      flowProps?.onNodeDragStart?.({}, node);
      flowProps?.onNodeDrag?.({}, node);
      flowProps?.onNodeDragStop?.({}, node);
    });
    const movedBoard = {
      ...board,
      objects: {
        ...board.objects,
        [IMPLEMENTING_ZONE_ID]: { ...board.objects?.[IMPLEMENTING_ZONE_ID], x: 2100, y: 400 },
      },
    } as Board;
    view.rerender(
      <ConnectionProvider value={connected}>
        <SessionCanvas board={movedBoard} client={client} branches={[branch]} />
      </ConnectionProvider>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(patch).not.toHaveBeenCalled();
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: IMPLEMENTING_ZONE_ID,
      position: implementingPlacement.position,
    });
  });

  it('does not persist a stale drag after same-zone auto-arrange advances', async () => {
    vi.useFakeTimers();
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;

    render(
      <ConnectionProvider value={connected}>
        <SessionCanvas board={board} client={client} branches={[branch]} />
      </ConnectionProvider>
    );
    await act(async () => {});

    const staleBranchNode = {
      ...currentNode(BRANCH_ID),
      position: { x: 60, y: 1240 },
      positionAbsolute: { x: 1800, y: 1320 },
      width: 500,
      height: 180,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, staleBranchNode);
      flowProps?.onNodeDrag?.({}, staleBranchNode);
      flowProps?.onNodeDragStop?.({}, staleBranchNode);
      boardObjectPatched({
        ...implementingPlacement,
        position: { x: 40, y: 260 },
      });
    });
    await act(async () => {});

    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: IMPLEMENTING_ZONE_ID,
      position: { x: 40, y: 260 },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('drops stale local absolute geometry when set_zone moves a branch before a delayed local echo', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;

    const view = render(
      <ConnectionProvider value={connected}>
        <SessionCanvas board={board} client={client} branches={[branch]} />
      </ConnectionProvider>
    );

    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: IMPLEMENTING_ZONE_ID,
      position: { x: 20, y: 100 },
    });

    // A local arrange/drag has accepted absolute geometry over the artifact,
    // but its debounced persistence has not completed yet.
    const staleLocalNode = {
      ...currentNode(BRANCH_ID),
      position: { x: 60, y: 1240 },
      positionAbsolute: { x: 1800, y: 1320 },
      width: 500,
      height: 180,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, staleLocalNode);
      flowProps?.onNodeDrag?.({}, staleLocalNode);
      flowProps?.onNodeDragStop?.({}, staleLocalNode);
    });

    // This is the real set_zone production boundary: the board-object event,
    // not a branch/session payload, owns zone_id and the zone-relative position.
    const reviewingPlacement = {
      ...implementingPlacement,
      zone_id: REVIEWING_ZONE_ID,
      position: { x: 20, y: 100 },
    };
    act(() => boardObjectPatched(reviewingPlacement));

    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 20, y: 100 },
      zIndex: 500,
    });

    const reviewZone = board.objects?.[REVIEWING_ZONE_ID];
    const artifact = board.objects?.['artifact-large'];
    expect(reviewZone?.type).toBe('zone');
    expect(artifact?.type).toBe('artifact');
    if (reviewZone?.type !== 'zone' || artifact?.type !== 'artifact') return;
    const authoritativeAbsoluteBottom = reviewZone.y + currentNode(BRANCH_ID).position.y + 180;
    expect(authoritativeAbsoluteBottom).toBeLessThan(artifact.y);

    // A subsequent automatic child arrange changes only the persisted relative
    // position. It is equally authoritative and must not be replaced by the
    // previous animation/drag absolute point.
    const secondStaleLocalNode = {
      ...currentNode(BRANCH_ID),
      position: { x: -1090, y: 1240 },
      positionAbsolute: { x: 1800, y: 1320 },
      width: 500,
      height: 180,
    };
    act(() => {
      flowProps?.onNodeDragStart?.({}, secondStaleLocalNode);
      flowProps?.onNodeDrag?.({}, secondStaleLocalNode);
      flowProps?.onNodeDragStop?.({}, secondStaleLocalNode);
      boardObjectPatched({
        ...reviewingPlacement,
        position: { x: 40, y: 260 },
      });
    });
    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 40, y: 260 },
    });

    // Moving the zone itself does not rewrite child placement. React Flow must
    // keep the child relationship and the same relative position across repeat
    // zone moves rather than materializing positionAbsolute into board state.
    const movedBoard = {
      ...board,
      objects: {
        ...board.objects,
        [REVIEWING_ZONE_ID]: {
          ...board.objects?.[REVIEWING_ZONE_ID],
          type: 'zone',
          x: 3050,
          y: 240,
        },
      },
    } as unknown as Board;
    view.rerender(
      <ConnectionProvider value={connected}>
        <SessionCanvas board={movedBoard} client={client} branches={[branch]} />
      </ConnectionProvider>
    );
    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 40, y: 260 },
    });

    // Session/task completion traffic may repaint the card, but cannot replace
    // the board-object placement or sever its React Flow parent relationship.
    act(() =>
      sessionPatched({
        session_id: 'session-1',
        branch_id: BRANCH_ID,
        status: 'completed',
        archived: false,
      } as unknown as Session)
    );
    view.rerender(
      <ConnectionProvider value={connected}>
        <SessionCanvas
          board={movedBoard}
          client={client}
          branches={[{ ...branch, notes: 'patched' }]}
        />
      </ConnectionProvider>
    );
    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 40, y: 260 },
    });

    view.unmount();

    // Hydration/remount has no local override state at all and reconstructs the
    // same parent/relative geometry solely from the board-object row.
    render(
      <ConnectionProvider value={connected}>
        <SessionCanvas board={movedBoard} client={client} branches={[branch]} />
      </ConnectionProvider>
    );
    await act(async () => {});
    expect(currentNode(BRANCH_ID)).toMatchObject({
      parentId: REVIEWING_ZONE_ID,
      position: { x: 40, y: 260 },
    });
  });
});
