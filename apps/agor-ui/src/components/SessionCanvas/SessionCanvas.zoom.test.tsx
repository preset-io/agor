// biome-ignore-all lint/plugin/noHardcodedColorLiteral: persisted zone palette fixtures verify canvas creation behavior

import { BOARD_SNAP_GRID } from '@agor/core/layout/rectangle-packing';
import type { AgorClient, Board } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import type { Node, NodeDragHandler } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import SessionCanvas, { isCanvasSelectionControlTarget } from './SessionCanvas';

let reactFlowProps: Record<string, unknown> | null = null;
// Stable spy for the `useNodesState` setter (onNodesChangeInternal). Lets tests
// assert that onNodesChange forwards changes to React Flow's internal handler.
const onNodesChangeInternalSpy = vi.fn();
// Stable spy for the raw setNodes setter (setNodesUnsafe). Lets tests inspect
// the functional updater passed when zIndex needs to change for zone selection.
const setNodesUnsafeSpy = vi.fn();
let nodesStateOverride: Node[] | undefined;

vi.mock('reactflow', () => ({
  Background: () => <div data-testid="react-flow-background" />,
  BackgroundVariant: { Dots: 'dots' },
  ControlButton: ({
    children,
    onClick,
    ...props
  }: {
    children?: ReactNode;
    onClick?: MouseEventHandler<HTMLButtonElement>;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Controls: ({ children }: { children?: ReactNode }) => (
    <div data-testid="react-flow-controls">{children}</div>
  ),
  MiniMap: () => <div data-testid="react-flow-minimap" />,
  ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
    reactFlowProps = props;
    return (
      <div data-testid="react-flow" className="react-flow__pane">
        <div
          data-testid="zone-selection-surface"
          className="react-flow__node react-flow__node-zone"
          data-id="zone-1"
        />
        {props.children}
      </div>
    );
  },
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useEdgesState: (initialEdges: unknown[]) => [initialEdges, vi.fn(), vi.fn()],
  useNodesState: (initialNodes: unknown[]) => [
    nodesStateOverride ?? initialNodes,
    setNodesUnsafeSpy,
    onNodesChangeInternalSpy,
  ],
}));

vi.mock('./canvas/AppNode', () => ({
  AppNode: () => <div data-testid="app-node" />,
}));

vi.mock('./canvas/ArtifactNode', () => ({
  ArtifactNode: () => <div data-testid="artifact-node" />,
}));

beforeEach(() => {
  reactFlowProps = null;
  nodesStateOverride = undefined;
  onNodesChangeInternalSpy.mockClear();
  setNodesUnsafeSpy.mockClear();
});

describe('SessionCanvas zoom shortcuts', () => {
  it('does not start a canvas selection gesture from portaled layout controls', () => {
    const popover = document.createElement('div');
    popover.className = 'canvas-layout-controls';
    const gridControl = document.createElement('span');
    popover.append(gridControl);

    expect(isCanvasSelectionControlTarget(gridControl)).toBe(true);
  });

  it('does not capture a portaled modal segmented option as a canvas gesture', () => {
    const modal = document.createElement('div');
    modal.className = 'ant-modal-root';
    const segmentedOption = document.createElement('span');
    segmentedOption.className = 'ant-segmented-item-label';
    modal.append(segmentedOption);

    expect(isCanvasSelectionControlTarget(segmentedOption)).toBe(true);
  });

  it('uses Command or Control plus scroll to zoom while preserving scroll panning', () => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);

    expect(reactFlowProps?.panOnScroll).toBe(true);
    expect(reactFlowProps?.zoomActivationKeyCode).toEqual(['Meta', 'Control']);
    expect(reactFlowProps?.selectionOnDrag).toBe(false);
    expect(reactFlowProps?.snapGrid).toBe(BOARD_SNAP_GRID);
  });

  it('marquee-selects partially intersected nested items through a non-1 zoom transform', () => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);
    const flowNodes: Node[] = [
      {
        id: 'zone-1',
        type: 'zone',
        position: { x: 100, y: 100 },
        width: 600,
        height: 500,
        data: {},
      },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone-1',
        position: { x: 40, y: 80 },
        width: 200,
        height: 120,
        data: {},
      },
      {
        id: 'card-1',
        type: 'cardNode',
        parentId: 'zone-1',
        position: { x: 280, y: 80 },
        width: 180,
        height: 100,
        data: {},
      },
    ];
    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        getNodes: () => flowNodes,
        getViewport: () => ({ x: 0, y: 0, zoom: 0.5 }),
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
          x: x / 0.5,
          y: y / 0.5,
        }),
      });
    });
    setNodesUnsafeSpy.mockClear();

    const surface = screen.getByTestId('zone-selection-surface');
    fireEvent.pointerDown(surface, { button: 0, pointerId: 7, clientX: 65, clientY: 80 });
    fireEvent.pointerMove(surface, { pointerId: 7, clientX: 245, clientY: 120, buttons: 1 });

    expect(document.querySelector('.canvas-marquee-selection')).toBeInTheDocument();
    const updater = setNodesUnsafeSpy.mock.calls.at(-1)?.[0] as
      | ((current: Node[]) => Node[])
      | undefined;
    const updated = updater?.(flowNodes);
    expect(updated?.filter((node) => node.selected).map((node) => node.id)).toEqual([
      'branch-1',
      'card-1',
    ]);

    fireEvent.pointerUp(surface, { button: 0, pointerId: 7, clientX: 245, clientY: 120 });
    expect(document.querySelector('.canvas-marquee-selection')).not.toBeInTheDocument();
  });

  it('runs nested worktree snapping through heterogeneous production peers', () => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);
    const flowNodes: Node[] = [
      {
        id: 'zone-1',
        type: 'zone',
        position: { x: 100, y: 100 },
        width: 600,
        height: 500,
        data: {},
      },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone-1',
        position: { x: 41, y: 80 },
        positionAbsolute: { x: 141, y: 180 },
        width: 200,
        height: 120,
        data: {},
      },
      {
        id: 'artifact-1',
        type: 'artifactNode',
        position: { x: 140, y: 400 },
        width: 300,
        height: 180,
        data: {},
      },
    ];
    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        getNodes: () => flowNodes,
        getViewport: () => ({ x: 10, y: 20, zoom: 0.5 }),
        getZoom: () => 0.5,
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
    });
    setNodesUnsafeSpy.mockClear();

    act(() => {
      (reactFlowProps?.onNodeDragStart as NodeDragHandler)?.({}, flowNodes[1], [flowNodes[1]]);
      (reactFlowProps?.onNodeDrag as (event: unknown, node: Node) => void)?.({}, flowNodes[1]);
    });

    const guide = document.querySelector<HTMLElement>(
      '.canvas-alignment-guide.vertical[data-guide-kind="alignment"]'
    );
    expect(guide).not.toBeNull();
    expect(guide).toHaveStyle({ left: '80px' });
    expect(guide?.style.height).not.toBe('100%');
    const updater = setNodesUnsafeSpy.mock.calls.at(-1)?.[0] as
      | ((current: Node[]) => Node[])
      | undefined;
    expect(updater?.(flowNodes).find((node) => node.id === 'branch-1')?.position.x).toBe(40);
  });

  it.each([
    ['worktree', 'branchNode', 'branch-1'],
    ['card', 'cardNode', 'card-1'],
  ])('keeps one compact %s size readout outside while dragging', (_label, type, id) => {
    render(<SessionCanvas board={null} client={null} branches={[]} />);
    const moving: Node = {
      id,
      type,
      position: { x: 300, y: 100 },
      width: 200,
      height: 120,
      data: {},
    };
    const flowNodes: Node[] = [
      moving,
      {
        id: 'peer',
        type: 'artifactNode',
        position: { x: 0, y: 0 },
        width: 200,
        height: 120,
        data: {},
      },
    ];
    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        getNodes: () => flowNodes,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getZoom: () => 1,
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
      (reactFlowProps?.onNodeDrag as (event: unknown, node: Node) => void)?.({}, moving);
    });

    const readout = document.querySelector<HTMLElement>('[data-guide-kind="size-readout"]');
    const sizeLines = document.querySelectorAll('.canvas-alignment-guide[data-guide-kind="size"]');
    expect(readout).toHaveTextContent('200 × 120');
    expect(sizeLines).toHaveLength(1);
    expect(Number.parseFloat(readout?.style.top ?? '')).toBeGreaterThan(220);
  });

  describe('automatic zone direct manipulation', () => {
    const autoBoard = {
      board_id: 'board-1',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 620,
          height: 900,
          label: 'Automatic',
          layout: { mode: 'auto', preset: 'grid' },
        },
      },
    } as unknown as Board;

    function renderAutoBoard() {
      const patch = vi.fn().mockResolvedValue({});
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      render(
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas
            board={autoBoard}
            client={client}
            branches={[]}
            sessionById={new Map()}
            sessionsByBranch={new Map()}
            userById={new Map()}
            repoById={new Map()}
            branchById={new Map()}
            boardObjectById={new Map()}
            boardObjectsByBoardId={new Map()}
            commentById={new Map()}
            cardById={new Map()}
          />
        </ConnectionProvider>
      );
      return { client, patch };
    }

    it('demotes before dragging a card already managed by the automatic zone', async () => {
      const { client, patch } = renderAutoBoard();

      act(() => {
        (reactFlowProps?.onNodeDragStart as (event: unknown, node: Node) => void)?.(
          {},
          {
            id: 'card-1',
            type: 'cardNode',
            parentId: 'zone-1',
            position: { x: 140, y: 160 },
            data: {},
          }
        );
      });

      await waitFor(() =>
        expect(patch).toHaveBeenCalledWith('board-1', {
          _action: 'upsertObject',
          objectId: 'zone-1',
          objectData: expect.objectContaining({
            type: 'zone',
            layout: expect.objectContaining({ mode: 'manual', preset: 'grid' }),
          }),
        })
      );
      expect(client.service).toHaveBeenCalledWith('boards');
    });

    it.each([
      ['the zone container', { id: 'zone-1', type: 'zone', parentId: undefined }],
      ['a card entering from outside', { id: 'card-new', type: 'cardNode', parentId: undefined }],
    ])('does not demote for dragging %s', async (_label, partialNode) => {
      const { patch } = renderAutoBoard();

      act(() => {
        (reactFlowProps?.onNodeDragStart as (event: unknown, node: Node) => void)?.({}, {
          ...partialNode,
          position: { x: 140, y: 160 },
          data: {},
        } as Node);
      });
      await Promise.resolve();

      expect(patch).not.toHaveBeenCalled();
    });
  });

  describe('React Flow group-drag persistence', () => {
    const connected = {
      connected: true,
      connecting: false,
      outOfSync: false,
      capturedSha: null,
      currentSha: null,
    };

    function renderDragCanvas(board: Board, client: AgorClient, getNodes: () => Node[]) {
      nodesStateOverride = getNodes();
      const view = render(
        <ConnectionProvider value={connected}>
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      );
      act(() => {
        (reactFlowProps?.onInit as (instance: unknown) => void)?.({
          getNodes,
          getViewport: () => ({ x: 0, y: 0, zoom: 0.5 }),
          getZoom: () => 0.5,
          screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
        });
      });
      return view;
    }

    function movedBy(node: Node, x: number, y: number): Node {
      const absolute = node.positionAbsolute ?? node.position;
      return {
        ...node,
        position: { x: node.position.x + x, y: node.position.y + y },
        positionAbsolute: { x: absolute.x + x, y: absolute.y + y },
      };
    }

    function applyLayoutPayload(board: Board, payload: Record<string, unknown>): Board {
      const updates = payload.objects as NonNullable<Board['objects']>;
      return {
        ...board,
        objects: Object.fromEntries(
          Object.entries(board.objects ?? {}).map(([objectId, object]) => [
            objectId,
            updates[objectId] ? { ...object, ...updates[objectId] } : object,
          ])
        ),
      } as Board;
    }

    it('atomically persists three unequal selected zones with one snapped delta only after debounce', async () => {
      let durableBoard = {
        board_id: 'board-1',
        objects: {
          'zone-a': {
            type: 'zone',
            x: 0,
            y: 0,
            width: 320,
            height: 240,
            label: 'A',
            layout: { mode: 'auto', preset: 'grid', resize: 'height', autoResizeHeight: true },
          },
          'zone-b': {
            type: 'zone',
            x: 500,
            y: 200,
            width: 640,
            height: 420,
            label: 'B',
            layout: { mode: 'manual', preset: 'compact_list', resize: 'height' },
          },
          'zone-c': {
            type: 'zone',
            x: 200,
            y: 800,
            width: 280,
            height: 520,
            label: 'C',
          },
          'zone-locked': {
            type: 'zone',
            x: 1500,
            y: 0,
            width: 300,
            height: 200,
            label: 'Locked',
            locked: true,
          },
          'zone-fixed': {
            type: 'zone',
            x: 1800,
            y: 500,
            width: 300,
            height: 200,
            label: 'Fixed',
          },
          peer: {
            type: 'zone',
            x: 805,
            y: 80,
            width: 200,
            height: 200,
            label: 'Guide peer',
          },
        },
      } as unknown as Board;
      const patch = vi.fn(async (_boardId: string, payload: Record<string, unknown>) => {
        durableBoard = applyLayoutPayload(durableBoard, payload);
        return {
          board: durableBoard,
          placements: [],
          changed: true,
          changed_object_ids: Object.keys(payload.objects as object),
          changed_placement_ids: [],
        };
      });
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      const zone = (
        id: string,
        x: number,
        y: number,
        width: number,
        height: number,
        extra: Partial<Node> = {}
      ): Node => ({
        id,
        type: 'zone',
        position: { x, y },
        positionAbsolute: { x, y },
        width,
        height,
        selected: true,
        data: {},
        ...extra,
      });
      const selected = [
        zone('zone-a', 0, 0, 320, 240),
        zone('zone-b', 500, 200, 640, 420),
        zone('zone-c', 200, 800, 280, 520),
      ];
      const child: Node = {
        id: 'branch-child',
        type: 'branchNode',
        parentId: 'zone-a',
        position: { x: 40, y: 60 },
        positionAbsolute: { x: 40, y: 60 },
        selected: true,
        data: {},
      };
      const locked = zone('zone-locked', 1500, 0, 300, 200, {
        draggable: false,
        data: { locked: true },
      });
      const fixed = zone('zone-fixed', 1800, 500, 300, 200, { selected: false });
      const peer = zone('peer', 805, 80, 200, 200, { selected: false });
      let liveNodes = [...selected, child, locked, fixed, peer];
      renderDragCanvas(durableBoard, client, () => liveNodes);

      // React Flow has applied the 20px grid delta. Its third callback argument
      // excludes both the selected child (owned by zone-a) and locked zone.
      const rawMoved = selected.map((node) => movedBy(node, 480, 80));
      liveNodes = [...rawMoved, child, locked, fixed, peer];
      setNodesUnsafeSpy.mockClear();

      vi.useFakeTimers();
      try {
        act(() => {
          (reactFlowProps?.onNodeDragStart as NodeDragHandler)?.({}, selected[0], selected);
          (reactFlowProps?.onNodeDrag as NodeDragHandler)?.({}, rawMoved[0], rawMoved);
          (reactFlowProps?.onNodeDragStop as NodeDragHandler)?.({}, rawMoved[0], rawMoved);
        });

        // Guide snapping aligns zone-a's right edge (800) to peer.x (805), so
        // every zone receives the same +5 guide correction on top of the grid delta.
        const acceptedResult = setNodesUnsafeSpy.mock.calls
          .map(([updater]) =>
            typeof updater === 'function' ? (updater as (value: Node[]) => Node[])(liveNodes) : []
          )
          .find((result) => result.find((node) => node.id === 'zone-a')?.position.x === 485);
        expect(
          acceptedResult
            ?.filter((node) => node.id.startsWith('zone-') && node.id !== 'zone-locked')
            .map((node) => [node.id, node.position])
        ).toEqual([
          ['zone-a', { x: 485, y: 80 }],
          ['zone-b', { x: 985, y: 280 }],
          ['zone-c', { x: 685, y: 880 }],
          ['zone-fixed', { x: 1800, y: 500 }],
        ]);
        expect(acceptedResult?.find((node) => node.id === child.id)).toMatchObject({
          parentId: 'zone-a',
          position: { x: 40, y: 60 },
        });

        await act(async () => vi.advanceTimersByTimeAsync(499));
        expect(patch).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTimeAsync(1));
      } finally {
        vi.useRealTimers();
      }

      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith('board-1', {
        _action: 'applyLayout',
        objects: {
          'zone-a': { x: 485, y: 80, width: 320, height: 240 },
          'zone-b': { x: 985, y: 280, width: 640, height: 420 },
          'zone-c': { x: 685, y: 880, width: 280, height: 520 },
        },
        placements: {},
      });
      expect(durableBoard.objects?.['zone-a']).toMatchObject({
        x: 485,
        y: 80,
        layout: { mode: 'auto', preset: 'grid', resize: 'height', autoResizeHeight: true },
      });
      expect(durableBoard.objects?.['zone-b']).toMatchObject({
        x: 985,
        y: 280,
        layout: { mode: 'manual', preset: 'compact_list', resize: 'height' },
      });
      expect(durableBoard.objects?.['zone-locked']).toMatchObject({ x: 1500, y: 0 });
      expect(durableBoard.objects?.['zone-fixed']).toMatchObject({ x: 1800, y: 500 });
    });

    it('holds both dropped zones through a stale echo, then reloads their authoritative positions', async () => {
      let durableBoard = {
        board_id: 'board-echo',
        objects: {
          'zone-a': { type: 'zone', x: 0, y: 0, width: 300, height: 200, label: 'A' },
          'zone-b': { type: 'zone', x: 500, y: 400, width: 450, height: 350, label: 'B' },
        },
      } as unknown as Board;
      const patch = vi.fn(async (_boardId: string, payload: Record<string, unknown>) => {
        durableBoard = applyLayoutPayload(durableBoard, payload);
        return {
          board: durableBoard,
          placements: [],
          changed: true,
          changed_object_ids: Object.keys(payload.objects as object),
          changed_placement_ids: [],
        };
      });
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      const start: Node[] = [
        {
          id: 'zone-a',
          type: 'zone',
          position: { x: 0, y: 0 },
          positionAbsolute: { x: 0, y: 0 },
          width: 300,
          height: 200,
          selected: true,
          data: {},
        },
        {
          id: 'zone-b',
          type: 'zone',
          position: { x: 500, y: 400 },
          positionAbsolute: { x: 500, y: 400 },
          width: 450,
          height: 350,
          selected: true,
          data: {},
        },
      ];
      let liveNodes = start;
      const view = renderDragCanvas(durableBoard, client, () => liveNodes);
      const moved = start.map((node) => movedBy(node, 120, 60));
      liveNodes = moved;

      vi.useFakeTimers();
      try {
        act(() => {
          (reactFlowProps?.onNodeDragStart as NodeDragHandler)?.({}, start[0], start);
          (reactFlowProps?.onNodeDrag as NodeDragHandler)?.({}, moved[0], moved);
          (reactFlowProps?.onNodeDragStop as NodeDragHandler)?.({}, moved[0], moved);
        });

        // A pre-debounce realtime board echo still contains the old positions.
        setNodesUnsafeSpy.mockClear();
        view.rerender(
          <ConnectionProvider value={connected}>
            <SessionCanvas board={{ ...durableBoard }} client={client} branches={[]} />
          </ConnectionProvider>
        );
        const staleEchoUpdater = setNodesUnsafeSpy.mock.calls.at(-1)?.[0] as
          | ((value: Node[]) => Node[])
          | undefined;
        const protectedNodes = staleEchoUpdater?.(moved);
        expect(protectedNodes?.find((node) => node.id === 'zone-a')?.position).toEqual({
          x: 120,
          y: 60,
        });
        expect(protectedNodes?.find((node) => node.id === 'zone-b')?.position).toEqual({
          x: 620,
          y: 460,
        });

        await act(async () => vi.advanceTimersByTimeAsync(500));
      } finally {
        vi.useRealTimers();
      }
      expect(patch).toHaveBeenCalledTimes(1);

      // An authoritative echo and a clean remount (reload/second consumer)
      // both reconstruct every zone at the one committed group snapshot.
      view.unmount();
      nodesStateOverride = undefined;
      setNodesUnsafeSpy.mockClear();
      render(
        <ConnectionProvider value={connected}>
          <SessionCanvas board={durableBoard} client={client} branches={[]} />
        </ConnectionProvider>
      );
      const reloaded = setNodesUnsafeSpy.mock.calls
        .map(([updater]) =>
          typeof updater === 'function' ? (updater as (value: Node[]) => Node[])([]) : []
        )
        .find((result) => result.some((node) => node.id === 'zone-a'));
      expect(reloaded?.find((node) => node.id === 'zone-a')?.position).toEqual({ x: 120, y: 60 });
      expect(reloaded?.find((node) => node.id === 'zone-b')?.position).toEqual({ x: 620, y: 460 });
    });

    it('keeps a no-op drag write-free and preserves the single-zone drag path', async () => {
      let durableBoard = {
        board_id: 'board-single',
        objects: {
          zone: { type: 'zone', x: 40, y: 80, width: 360, height: 240, label: 'Single' },
        },
      } as unknown as Board;
      const patch = vi.fn(async (_boardId: string, payload: Record<string, unknown>) => {
        durableBoard = applyLayoutPayload(durableBoard, payload);
        return {
          board: durableBoard,
          placements: [],
          changed: true,
          changed_object_ids: ['zone'],
          changed_placement_ids: [],
        };
      });
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      const start: Node = {
        id: 'zone',
        type: 'zone',
        position: { x: 40, y: 80 },
        positionAbsolute: { x: 40, y: 80 },
        width: 360,
        height: 240,
        selected: true,
        data: {},
      };
      let liveNodes = [start];
      renderDragCanvas(durableBoard, client, () => liveNodes);

      vi.useFakeTimers();
      try {
        act(() => {
          (reactFlowProps?.onNodeDragStart as NodeDragHandler)?.({}, start, [start]);
          (reactFlowProps?.onNodeDragStop as NodeDragHandler)?.({}, start, [start]);
        });
        await act(async () => vi.advanceTimersByTimeAsync(500));
        expect(patch).not.toHaveBeenCalled();

        const moved = movedBy(start, 80, 40);
        liveNodes = [moved];
        act(() => {
          (reactFlowProps?.onNodeDragStart as NodeDragHandler)?.({}, start, [start]);
          (reactFlowProps?.onNodeDrag as NodeDragHandler)?.({}, moved, [moved]);
          (reactFlowProps?.onNodeDragStop as NodeDragHandler)?.({}, moved, [moved]);
        });
        await act(async () => vi.advanceTimersByTimeAsync(500));
      } finally {
        vi.useRealTimers();
      }

      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith('board-single', {
        _action: 'applyLayout',
        objects: { zone: { x: 120, y: 120, width: 360, height: 240 } },
        placements: {},
      });
    });

    it('serializes rapid group drops so an older in-flight batch cannot win last', async () => {
      let durableBoard = {
        board_id: 'board-rapid',
        objects: {
          'zone-a': { type: 'zone', x: 0, y: 0, width: 300, height: 200, label: 'A' },
          'zone-b': { type: 'zone', x: 500, y: 300, width: 420, height: 260, label: 'B' },
        },
      } as unknown as Board;
      let releaseFirst: (() => void) | undefined;
      let callCount = 0;
      const patch = vi.fn(async (_boardId: string, payload: Record<string, unknown>) => {
        callCount += 1;
        const resultBoard = applyLayoutPayload(durableBoard, payload);
        if (callCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        durableBoard = resultBoard;
        return {
          board: resultBoard,
          placements: [],
          changed: true,
          changed_object_ids: Object.keys(payload.objects as object),
          changed_placement_ids: [],
        };
      });
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      const start: Node[] = [
        {
          id: 'zone-a',
          type: 'zone',
          position: { x: 0, y: 0 },
          positionAbsolute: { x: 0, y: 0 },
          width: 300,
          height: 200,
          selected: true,
          data: {},
        },
        {
          id: 'zone-b',
          type: 'zone',
          position: { x: 500, y: 300 },
          positionAbsolute: { x: 500, y: 300 },
          width: 420,
          height: 260,
          selected: true,
          data: {},
        },
      ];
      let liveNodes = start;
      renderDragCanvas(durableBoard, client, () => liveNodes);
      const drag = (from: Node[], to: Node[]) => {
        act(() => {
          (reactFlowProps?.onNodeDragStart as NodeDragHandler)?.({}, from[0], from);
          (reactFlowProps?.onNodeDrag as NodeDragHandler)?.({}, to[0], to);
          (reactFlowProps?.onNodeDragStop as NodeDragHandler)?.({}, to[0], to);
        });
      };

      vi.useFakeTimers();
      try {
        const first = start.map((node) => movedBy(node, 100, 100));
        liveNodes = first;
        drag(start, first);
        await act(async () => vi.advanceTimersByTimeAsync(500));
        expect(patch).toHaveBeenCalledTimes(1);

        const second = first.map((node) => movedBy(node, 60, 40));
        liveNodes = second;
        drag(first, second);
        await act(async () => vi.advanceTimersByTimeAsync(500));
        expect(patch).toHaveBeenCalledTimes(1);

        await act(async () => {
          releaseFirst?.();
          await Promise.resolve();
          await Promise.resolve();
        });
      } finally {
        vi.useRealTimers();
      }

      expect(patch).toHaveBeenCalledTimes(2);
      expect(patch.mock.calls.map(([, payload]) => payload.objects)).toEqual([
        {
          'zone-a': { x: 100, y: 100, width: 300, height: 200 },
          'zone-b': { x: 600, y: 400, width: 420, height: 260 },
        },
        {
          'zone-a': { x: 160, y: 140, width: 300, height: 200 },
          'zone-b': { x: 660, y: 440, width: 420, height: 260 },
        },
      ]);
    });
  });

  it('opens the markdown note modal when the markdown tool clicks a board node', async () => {
    render(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <SessionCanvas
          board={
            {
              board_id: 'board-1',
              name: 'Board',
              slug: 'board',
              objects: {
                'zone-1': {
                  type: 'zone',
                  x: 0,
                  y: 0,
                  width: 1200,
                  height: 900,
                  label: 'Large Zone',
                  borderColor: '#d9d9d9',
                  backgroundColor: '#d9d9d91a',
                },
              },
              created_at: '2026-06-18T00:00:00.000Z',
              last_updated: '2026-06-18T00:00:00.000Z',
              created_by: 'user-1',
              url: 'http://localhost/ui/b/board/',
              archived: false,
            } as unknown as Board
          }
          client={null}
          branches={[]}
        />
      </ConnectionProvider>
    );

    act(() => {
      (reactFlowProps?.onInit as (instance: unknown) => void)?.({
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Markdown Note' }));
    await waitFor(() => expect(reactFlowProps?.className).toBe('tool-mode-markdown'));

    act(() => {
      (reactFlowProps?.onNodeClick as (event: unknown, node: unknown) => void)?.(
        { clientX: 240, clientY: 320 },
        { id: 'zone-1', type: 'zone' }
      );
    });

    expect(await screen.findByText('Add Markdown Note')).toBeInTheDocument();
  });

  describe('onNodesChange zone resize via O(1) getNode lookup', () => {
    const zoneBoard = {
      board_id: 'board-1',
      name: 'Board',
      slug: 'board',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 0,
          y: 0,
          width: 1200,
          height: 900,
          label: 'Large Zone',
          borderColor: '#d9d9d9',
          backgroundColor: '#d9d9d91a',
          layout: { mode: 'auto', resize: 'height', autoResizeHeight: true },
        },
      },
      created_at: '2026-06-18T00:00:00.000Z',
      last_updated: '2026-06-18T00:00:00.000Z',
      created_by: 'user-1',
      url: 'http://localhost/ui/b/board/',
      archived: false,
    } as unknown as Board;

    // Render the canvas, then wire up React Flow's instance via onInit with a
    // controlled `getNode`. During a real resize React Flow mutates the live
    // node style before emitting onNodesChange, so tests can supply that live
    // geometry independently from the persisted board snapshot.
    function renderCanvas(
      client: AgorClient | null,
      liveStyle: { width: number; height: number } = { width: 1200, height: 900 }
    ) {
      render(
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas
            board={zoneBoard}
            client={client}
            sessionById={new Map()}
            sessionsByBranch={new Map()}
            userById={new Map()}
            repoById={new Map()}
            branches={[]}
            branchById={new Map()}
            boardObjectById={new Map()}
            boardObjectsByBoardId={new Map()}
            commentById={new Map()}
            cardById={new Map()}
          />
        </ConnectionProvider>
      );

      const zoneNode = {
        id: 'zone-1',
        type: 'zone',
        position: { x: 0, y: 0 },
        style: liveStyle,
      };
      const getNode = vi.fn((id: string) => (id === 'zone-1' ? zoneNode : undefined));
      act(() => {
        (reactFlowProps?.onInit as (instance: unknown) => void)?.({
          getNode,
          screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
          fitView: vi.fn(),
        });
      });

      const onNodesChange = reactFlowProps?.onNodesChange as (changes: unknown[]) => void;
      return { getNode, onNodesChange };
    }

    function makeClient() {
      const patch = vi.fn().mockResolvedValue({});
      const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
      return { client, patch };
    }

    it('forwards non-dimensions changes through onNodesChangeInternal', () => {
      const { onNodesChange } = renderCanvas(null);
      const changes = [{ type: 'position', id: 'zone-1', position: { x: 5, y: 5 } }];

      act(() => onNodesChange(changes));

      expect(onNodesChangeInternalSpy).toHaveBeenCalledWith(changes);
    });

    it('skips persisting a no-op resize within the 1px tolerance', async () => {
      const { client, patch } = makeClient();
      const { getNode, onNodesChange } = renderCanvas(client);

      vi.useFakeTimers();
      // Incoming dims sit within 1px of the node's current 1200x900 → no-op.
      act(() =>
        onNodesChange([
          {
            type: 'dimensions',
            id: 'zone-1',
            resizing: true,
            dimensions: { width: 1200.4, height: 899.6 },
          },
        ])
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      vi.useRealTimers();

      expect(getNode).toHaveBeenCalledWith('zone-1'); // real lookup HIT
      expect(patch).not.toHaveBeenCalled(); // no debounce-persist for a no-op
      expect(onNodesChangeInternalSpy).toHaveBeenCalled(); // change still forwarded
    });

    it('debounce-persists a real resize via a boards patch after 500ms', async () => {
      const { client, patch } = makeClient();
      const { onNodesChange } = renderCanvas(client, { width: 1000, height: 700 });

      vi.useFakeTimers();
      act(() =>
        onNodesChange([
          {
            type: 'dimensions',
            id: 'zone-1',
            resizing: true,
            dimensions: { width: 1000, height: 700 },
          },
        ])
      );

      // Nothing persisted until the 500ms debounce elapses.
      expect(patch).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      vi.useRealTimers();

      expect(client.service).toHaveBeenCalledWith('boards');
      expect(patch).toHaveBeenCalledWith(
        'board-1',
        expect.objectContaining({
          _action: 'upsertObject',
          objectId: 'zone-1',
          objectData: expect.objectContaining({
            type: 'zone',
            width: 1000,
            height: 700,
            layout: expect.objectContaining({
              mode: 'auto',
              resize: 'height',
              autoResizeHeight: true,
            }),
          }),
        })
      );
    });

    it('persists the paired origin from a top-left resize in the same zone patch', async () => {
      const { client, patch } = makeClient();
      const { onNodesChange } = renderCanvas(client);

      vi.useFakeTimers();
      act(() =>
        onNodesChange([
          { type: 'position', id: 'zone-1', position: { x: 200, y: 100 } },
          {
            type: 'dimensions',
            id: 'zone-1',
            resizing: true,
            dimensions: { width: 1000, height: 800 },
          },
        ])
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      vi.useRealTimers();

      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith(
        'board-1',
        expect.objectContaining({
          _action: 'upsertObject',
          objectId: 'zone-1',
          objectData: expect.objectContaining({
            x: 200,
            y: 100,
            width: 1000,
            height: 800,
          }),
        })
      );
    });

    it('treats a dimensions change for an unknown id as a safe no-op miss', () => {
      const { client, patch } = makeClient();
      const { getNode, onNodesChange } = renderCanvas(client);

      expect(() =>
        act(() =>
          onNodesChange([
            {
              type: 'dimensions',
              id: 'missing-node',
              resizing: true,
              dimensions: { width: 10, height: 10 },
            },
          ])
        )
      ).not.toThrow();

      expect(getNode).toHaveBeenCalledWith('missing-node');
      expect(patch).not.toHaveBeenCalled();
    });

    describe('zone select zIndex', () => {
      // The setNodes wrapper in SessionCanvas calls setNodesUnsafe with a
      // functional updater. We capture that updater and call it with mock nodes
      // to assert what the zIndex transition produces.
      function getLastSetNodesUpdater() {
        const calls = setNodesUnsafeSpy.mock.calls;
        const last = calls.at(-1);
        return last?.[0] as ((nodes: unknown[]) => unknown[]) | undefined;
      }

      it('raises zone zIndex to 101 when the zone is selected', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 100 }];
        const result = updater!(mockNodes) as typeof mockNodes;
        expect(result[0].zIndex).toBe(101);
      });

      it('restores zone zIndex to 100 when the zone is deselected', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: false }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 101 }];
        const result = updater!(mockNodes) as typeof mockNodes;
        expect(result[0].zIndex).toBe(100);
      });

      it('returns the same node array reference when no zone is in the select changes', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        // Select a non-zone node (e.g. a branch) — zone-1 is untouched
        act(() => onNodesChange([{ type: 'select', id: 'branch-999', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 100 }];
        const result = updater!(mockNodes);
        // Guard returns currentNodes unchanged so React can bail out on re-render
        expect(result).toBe(mockNodes);
      });

      it('returns the same node array reference when zone zIndex is already current', () => {
        const { onNodesChange } = renderCanvas(null);
        setNodesUnsafeSpy.mockClear();

        act(() => onNodesChange([{ type: 'select', id: 'zone-1', selected: true }]));

        const updater = getLastSetNodesUpdater();
        expect(updater).toBeDefined();
        const mockNodes = [{ id: 'zone-1', type: 'zone', zIndex: 101 }];
        const result = updater!(mockNodes);
        // No-op select echoes from React Flow must not allocate a fresh nodes
        // array, or controlled ReactFlow can re-emit selection indefinitely.
        expect(result).toBe(mockNodes);
      });
    });
  });

  it('exposes Arrange board by accessible name and explains an empty board', async () => {
    render(
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <SessionCanvas board={null} client={null} branches={[]} />
      </ConnectionProvider>
    );

    const button = screen.getByRole('button', { name: 'Arrange board' });
    expect(button).toBeDisabled();
    fireEvent.mouseOver(button.parentElement as HTMLElement);
    expect(
      await screen.findByText('Arrange board — no visible unlocked board items to arrange')
    ).toBeInTheDocument();
  });

  it('keeps focus while an Arrange board transaction blocks keyboard and double activation', async () => {
    nodesStateOverride = [
      {
        id: 'zone-1',
        type: 'zone',
        position: { x: 1200, y: 900 },
        width: 620,
        height: 500,
        data: {},
      },
    ];
    let releaseWrite: (() => void) | undefined;
    const patch = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseWrite = () => resolve({});
        })
    );
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const board = {
      board_id: 'board-1',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 1200,
          y: 900,
          width: 620,
          height: 500,
          label: 'Zone',
        },
      },
    } as unknown as Board;
    render(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      </AntApp>
    );

    const button = screen.getByRole('button', { name: 'Arrange board' });
    expect(button).toBeEnabled();
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    const options = await screen.findByRole('dialog', { name: 'Arrange board options' });
    expect(within(options).getByRole('radio', { name: 'Grid' })).toBeChecked();
    expect(within(options).getByRole('checkbox', { name: 'Pack zone contents' })).toBeChecked();
    expect(within(options).getByText('Preserve current expansion')).toBeInTheDocument();
    expect(
      within(options).getByRole('checkbox', { name: 'Match / resize zone frames' })
    ).toBeChecked();
    expect(within(options).getByRole('checkbox', { name: 'Justify rows' })).toBeChecked();
    expect(
      within(options).getByRole('checkbox', { name: 'Fit view after arranging' })
    ).toBeChecked();
    expect(within(options).getByText(/preserve the current camera/i)).toBeInTheDocument();
    expect(within(options).getByRole('combobox', { name: 'Last row behavior' })).toBeEnabled();
    expect(within(options).getByText('Last row: left')).toBeInTheDocument();
    fireEvent.click(within(options).getByRole('button', { name: 'Arrange board' }));

    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(patch).toHaveBeenCalledTimes(1);

    releaseWrite?.();
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'false'));
    expect(button).toHaveFocus();
  });

  it('defaults Pack zone contents on and preserves the frame when the user turns it off', async () => {
    nodesStateOverride = [
      {
        id: 'zone-1',
        type: 'zone',
        position: { x: 1200, y: 900 },
        width: 620,
        height: 500,
        data: {},
      },
    ];
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const board = {
      board_id: 'board-1',
      objects: {
        'zone-1': {
          type: 'zone',
          x: 1200,
          y: 900,
          width: 620,
          height: 500,
          label: 'Zone',
        },
      },
    } as unknown as Board;
    render(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Arrange board' }));
    const options = await screen.findByRole('dialog', { name: 'Arrange board options' });
    const pack = within(options).getByRole('checkbox', { name: 'Pack zone contents' });
    expect(pack).toBeChecked();
    fireEvent.click(pack);
    expect(pack).not.toBeChecked();
    expect(within(options).getByRole('combobox', { name: 'Content expansion' })).toBeDisabled();
    expect(within(options).getByText(/no child presentation is changed/i)).toBeInTheDocument();
    fireEvent.click(within(options).getByRole('button', { name: 'Arrange board' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'applyLayout',
        objects: {
          'zone-1': expect.objectContaining({ width: 620, height: 500 }),
        },
      })
    );
  });

  it('atomically grids a heterogeneous selection around an unselected fixed obstacle', async () => {
    nodesStateOverride = [
      {
        id: 'note-a',
        type: 'markdown',
        position: { x: 0, y: 0 },
        positionAbsolute: { x: 0, y: 0 },
        width: 200,
        height: 100,
        selected: true,
        data: {},
      },
      {
        id: 'app-b',
        type: 'appNode',
        position: { x: 800, y: 0 },
        positionAbsolute: { x: 800, y: 0 },
        width: 300,
        height: 160,
        selected: true,
        data: {},
      },
      {
        id: 'artifact-c',
        type: 'artifactNode',
        position: { x: 0, y: 500 },
        positionAbsolute: { x: 0, y: 500 },
        width: 240,
        height: 200,
        selected: true,
        data: {},
      },
      {
        id: 'fixed-note',
        type: 'markdown',
        position: { x: 380, y: 260 },
        width: 300,
        height: 160,
        data: { locked: true },
      },
    ];
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    let board = {
      board_id: 'board-1',
      objects: {
        'note-a': { type: 'markdown', x: 0, y: 0, width: 200, content: 'A' },
        'app-b': {
          type: 'app',
          x: 800,
          y: 0,
          width: 300,
          height: 160,
          title: 'B',
          files: {},
        },
        'artifact-c': {
          type: 'artifact',
          x: 0,
          y: 500,
          width: 240,
          height: 200,
          artifact_id: 'artifact-1',
        },
        'fixed-note': {
          type: 'markdown',
          x: 380,
          y: 260,
          width: 300,
          content: 'Fixed',
        },
      },
    } as unknown as Board;
    const view = render(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(await screen.findByText('Grid', { exact: true }));
    fireEvent.change(screen.getByLabelText('Number of columns'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const write = patch.mock.calls[0]?.[1];
    expect(write).toMatchObject({ _action: 'applyLayout', placements: {} });
    expect(Object.keys(write.objects)).toEqual(['note-a', 'app-b', 'artifact-c']);
    expect(write.objects['fixed-note']).toBeUndefined();
    expect(write.objects['note-a']).toMatchObject({ x: 140, y: 60 });
    expect(write.objects['app-b']).toMatchObject({ x: 380, y: 60 });
    expect(write.objects['artifact-c']).toMatchObject({ x: 720, y: 60 });

    board = { ...board, objects: { ...board.objects, ...write.objects } };
    nodesStateOverride = nodesStateOverride?.map((node) => {
      const object = write.objects[node.id];
      return object ? { ...node, position: { x: object.x, y: object.y } } : node;
    });
    view.rerender(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      </AntApp>
    );
    patch.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }));
    await act(async () => Promise.resolve());
    expect(patch).not.toHaveBeenCalled();
  });

  it('atomically matches an unequal three-zone grid to uniform tracks and repeats as a no-op', async () => {
    nodesStateOverride = [
      {
        id: 'zone-empty',
        type: 'zone',
        position: { x: 0, y: 0 },
        width: 600,
        height: 240,
        selected: true,
        data: {},
      },
      {
        id: 'zone-tall',
        type: 'zone',
        position: { x: 800, y: 0 },
        width: 600,
        height: 700,
        selected: true,
        data: {},
      },
      {
        id: 'tall-note',
        type: 'markdown',
        position: { x: 820, y: 100 },
        width: 380,
        height: 500,
        data: {},
      },
      {
        id: 'zone-wide',
        type: 'zone',
        position: { x: 0, y: 900 },
        width: 900,
        height: 300,
        selected: true,
        data: {},
      },
      {
        id: 'wide-note',
        type: 'markdown',
        position: { x: 20, y: 980 },
        width: 760,
        height: 120,
        data: {},
      },
      {
        id: 'locked-peer',
        type: 'zone',
        position: { x: 1600, y: 200 },
        width: 300,
        height: 180,
        selected: true,
        data: { locked: true },
      },
    ];
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    let board = {
      board_id: 'board-1',
      objects: {
        'zone-empty': { type: 'zone', x: 0, y: 0, width: 600, height: 240, label: 'Empty' },
        'zone-tall': { type: 'zone', x: 800, y: 0, width: 600, height: 700, label: 'Tall' },
        'tall-note': { type: 'markdown', x: 820, y: 100, width: 380, content: 'Tall' },
        'zone-wide': { type: 'zone', x: 0, y: 900, width: 900, height: 300, label: 'Wide' },
        'wide-note': { type: 'markdown', x: 20, y: 980, width: 760, content: 'Wide' },
        'locked-peer': {
          type: 'zone',
          x: 1600,
          y: 200,
          width: 300,
          height: 180,
          label: 'Locked',
        },
      },
    } as unknown as Board;
    const view = render(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(await screen.findByText('Grid', { exact: true }));
    expect(screen.getByRole('switch', { name: 'Match zone frames to grid' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Number of columns'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const write = patch.mock.calls[0]?.[1];
    expect(write).toMatchObject({ _action: 'applyLayout', placements: {} });
    expect(write.objects['locked-peer']).toBeUndefined();
    const empty = write.objects['zone-empty'];
    const tall = write.objects['zone-tall'];
    const wide = write.objects['zone-wide'];
    expect(empty.width).toBe(wide.width);
    expect(empty.height).toBe(tall.height);
    expect(tall.x - (empty.x + empty.width)).toBe(40);
    expect(wide.y - (empty.y + empty.height)).toBe(40);

    board = { ...board, objects: { ...board.objects, ...write.objects } } as Board;
    nodesStateOverride = nodesStateOverride.map((node) => {
      const object = write.objects[node.id];
      return object
        ? {
            ...node,
            position: { x: object.x, y: object.y },
            ...('width' in object ? { width: object.width } : {}),
            ...('height' in object ? { height: object.height } : {}),
          }
        : node;
    });
    view.rerender(
      <AntApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <SessionCanvas board={board} client={client} branches={[]} />
        </ConnectionProvider>
      </AntApp>
    );
    patch.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }));
    await act(async () => Promise.resolve());
    expect(patch).not.toHaveBeenCalled();
  });
});
