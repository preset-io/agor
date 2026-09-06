import { BOARD_GRID_SIZE } from '@agor/core/layout/rectangle-packing';
import type { Board, BoardObject } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import type { Node } from 'reactflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { useBoardObjects } from './useBoardObjects';

// Spy the themed error toast so the failure path of reorderObject is observable.
const { showError, showSuccess, showWarning } = vi.hoisted(() => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showWarning: vi.fn(),
}));
vi.mock('../../../utils/message', () => ({
  useThemedMessage: () => ({
    showError,
    showSuccess,
    showWarning,
    showInfo: vi.fn(),
    showLoading: vi.fn(),
    destroy: vi.fn(),
  }),
}));

const connectionState = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

beforeEach(() => {
  showError.mockClear();
  showSuccess.mockClear();
  showWarning.mockClear();
  connectionState.connected = true;
  connectionState.connecting = false;
  connectionState.outOfSync = false;
});

describe('justifyZoneContents production path', () => {
  const zoneId = 'demo-zone-review';
  const zone = {
    type: 'zone',
    x: -860,
    y: 240,
    width: 540,
    height: 500,
    label: 'Review',
  };
  const branch = {
    id: 'branch-review',
    type: 'branchNode',
    parentId: zoneId,
    position: { x: 20, y: 100 },
    width: 500,
    height: 240,
    data: { branch: { name: 'Review branch' } },
  } satisfies Node;

  function renderJustify(nodes: Node[], placements: unknown[]) {
    const routed = makeRoutedClient();
    const setNodes = vi.fn();
    const hook = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone }),
          client: routed.client,
          boardObjectsForBoard: placements as never,
          nodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    return { ...routed, setNodes, ...hook };
  }

  it('centers a single narrow child horizontally and persists its relative position', async () => {
    const narrow = { ...branch, width: 380 } satisfies Node;
    const view = renderJustify(
      [narrow],
      [
        {
          object_id: 'placement-branch',
          branch_id: branch.id,
          zone_id: zoneId,
          position: narrow.position,
        },
      ]
    );

    await act(async () => view.result.current.justifyZoneContents(zoneId, 'middle'));

    expect(view.boardsPatch).toHaveBeenCalledTimes(1);
    expect(layoutPlacements(view.boardsPatch)).toMatchObject({
      'placement-branch': { position: { x: 80, y: 100 }, size: { width: 380, height: 240 } },
    });
    expect(view.boardObjectsPatch).not.toHaveBeenCalled();
    expect(view.setNodes).toHaveBeenCalledTimes(1);
    expect(showSuccess).toHaveBeenCalledWith('Justified 1 items to the center.');
  });

  it('centers a child vertically and persists only its relative Y position', async () => {
    const view = renderJustify(
      [branch],
      [
        {
          object_id: 'placement-branch',
          branch_id: branch.id,
          zone_id: zoneId,
          position: branch.position,
        },
      ]
    );

    await act(async () => view.result.current.justifyZoneContents(zoneId, 'vertical_middle'));

    expect(view.boardsPatch).toHaveBeenCalledTimes(1);
    expect(layoutPlacements(view.boardsPatch)).toMatchObject({
      'placement-branch': { position: { x: 20, y: 140 }, size: { width: 500, height: 240 } },
    });
    expect(view.boardObjectsPatch).not.toHaveBeenCalled();
    expect(view.setNodes).toHaveBeenCalledTimes(1);
    expect(showSuccess).toHaveBeenCalledWith('Centered 1 items vertically in the zone.');
  });

  it('centers the seeded Review rows independently while preserving their Y positions', async () => {
    const card = {
      id: 'card-review',
      type: 'cardNode',
      parentId: zoneId,
      position: { x: 20, y: 380 },
      width: 380,
      height: 100,
      data: { card: { title: 'Review card', data: {} } },
    } satisfies Node;
    const view = renderJustify(
      [branch, card],
      [
        {
          object_id: 'placement-branch',
          branch_id: branch.id,
          zone_id: zoneId,
          position: branch.position,
        },
        {
          object_id: 'placement-card',
          card_id: 'review',
          zone_id: zoneId,
          position: card.position,
        },
      ]
    );

    await act(async () => view.result.current.justifyZoneContents(zoneId, 'middle'));

    expect(view.boardsPatch).toHaveBeenCalledTimes(1);
    expect(layoutPlacements(view.boardsPatch)).toMatchObject({
      'placement-card': { position: { x: 80, y: 380 }, size: { width: 380, height: 100 } },
    });
    expect(view.boardObjectsPatch).not.toHaveBeenCalled();
    expect(view.setNodes).toHaveBeenCalledTimes(1);
    expect(showSuccess).toHaveBeenCalledWith('Justified 1 items to the center.');
  });

  it('aligns inside configured Grid cells and commits one authoritative batch', async () => {
    const gridZone = {
      ...zone,
      width: 820,
      height: 760,
      layout: { mode: 'manual', preset: 'grid', columns: 2, gap: 40 },
    } as const;
    const gridNodes: Node[] = [
      { ...branch, id: 'wide', width: 360, height: 120, position: { x: 20, y: 100 } },
      { ...branch, id: 'tall', width: 180, height: 300, position: { x: 420, y: 100 } },
      { ...branch, id: 'narrow', width: 160, height: 180, position: { x: 20, y: 440 } },
      { ...branch, id: 'partial', width: 320, height: 100, position: { x: 420, y: 440 } },
    ];
    const placements = gridNodes.map((node) => ({
      object_id: `placement-${node.id}`,
      branch_id: node.id,
      zone_id: zoneId,
      position: node.position,
      size: { width: node.width, height: node.height },
    }));
    const routed = makeRoutedClient();
    const view = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: gridZone }),
          client: routed.client,
          boardObjectsForBoard: placements as never,
          nodes: gridNodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => view.result.current.justifyZoneContents(zoneId, 'right'));

    expect(routed.boardsPatch).toHaveBeenCalledTimes(1);
    expect(routed.boardObjectsPatch).not.toHaveBeenCalled();
    const written = layoutPlacements(routed.boardsPatch) as Record<
      string,
      { position: { x: number; y: number } }
    >;
    expect(written['placement-narrow']?.position.x).toBe(220);
    expect(written['placement-tall']?.position.x).toBe(560);
    expect(written['placement-narrow']?.position.y).toBe(440);
    expect(written['placement-tall']?.position.y).toBe(100);
  });
});

describe('stale layout recovery production path', () => {
  const zoneId = 'zone-current';
  const staleBoard = {
    board_id: 'board-1',
    objects: {
      [zoneId]: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 620,
        height: 560,
        label: 'Current',
        layout: {
          mode: 'manual',
          preset: 'grid',
          density: 'collapse',
          columns: 1,
          gap: 12,
        },
      },
    },
  } as unknown as Board;
  const freshBoard = {
    board_id: 'board-1',
    objects: {
      [zoneId]: {
        type: 'zone',
        x: 40,
        y: 60,
        width: 620,
        height: 560,
        label: 'Current',
        layout: {
          mode: 'manual',
          preset: 'grid',
          density: 'collapse',
          columns: 1,
          gap: 12,
        },
      },
    },
  } as unknown as Board;
  const stalePlacement = {
    object_id: 'placement-current',
    board_id: 'board-1',
    entity_type: 'branch',
    branch_id: 'branch-current',
    zone_id: zoneId,
    position: { x: 180, y: 260 },
    size: { width: 500, height: 220 },
  };
  const freshPlacement = {
    ...stalePlacement,
    position: { x: 120, y: 180 },
    size: { width: 500, height: 240 },
  };
  const staleNodes: Node[] = [
    {
      id: zoneId,
      type: 'zone',
      position: { x: 0, y: 0 },
      width: 620,
      height: 560,
      data: {},
    },
    {
      id: 'branch-current',
      type: 'branchNode',
      parentId: zoneId,
      position: { x: 180, y: 260 },
      width: 500,
      height: 220,
      data: { branch: { name: 'Fictional branch' } },
    },
  ];

  function renderStaleRecovery(options?: { auto?: boolean; staleAttempts?: number }) {
    const board = options?.auto
      ? makeBoard({
          [zoneId]: {
            ...staleBoard.objects?.[zoneId],
            type: 'zone',
            layout: { mode: 'auto', preset: 'grid', columns: 1, gap: 12 },
          },
        })
      : staleBoard;
    const authoritativeBoard = options?.auto
      ? makeBoard({
          [zoneId]: {
            ...freshBoard.objects?.[zoneId],
            type: 'zone',
            layout: { mode: 'auto', preset: 'grid', columns: 1, gap: 12 },
          },
        })
      : freshBoard;
    const staleAttempts = options?.staleAttempts ?? 1;
    let applyAttempts = 0;
    const boardsPatch = vi.fn().mockImplementation((boardId, data) => {
      if (data?._action !== 'applyLayout') return {};
      applyAttempts += 1;
      if (applyAttempts <= staleAttempts) {
        return Promise.reject(new Error('RepositoryError: Board layout source snapshot is stale'));
      }
      return mockBoardPatchResult(boardId, data);
    });
    const boardsGet = vi.fn().mockResolvedValue(authoritativeBoard);
    const placementsFindAll = vi.fn().mockResolvedValue([freshPlacement]);
    const service = vi.fn((path: string) =>
      path === 'boards'
        ? { patch: boardsPatch, get: boardsGet }
        : { patch: vi.fn(), findAll: placementsFindAll }
    );
    const setNodes = vi.fn();
    const view = renderHook(
      () =>
        useBoardObjects({
          board,
          client: { service } as never,
          boardObjectsForBoard: [stalePlacement] as never,
          nodes: staleNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    return { ...view, boardsPatch, boardsGet, placementsFindAll, setNodes };
  }

  it('replans one stale explicit zone action from authoritative geometry without a stale optimistic write', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = renderStaleRecovery();
    const zoneNode = view.result.current.getBoardObjectNodes().find((node) => node.id === zoneId);
    expect(zoneNode).toBeDefined();

    await act(async () => {
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)(zoneId);
    });

    const writes = layoutWrites(view.boardsPatch);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.expected).toMatchObject({
      objects: { [zoneId]: { x: 40, y: 60, width: 620, height: 560 } },
      placements: {
        'placement-current': {
          position: { x: 120, y: 180 },
          size: { width: 500, height: 240 },
        },
      },
    });
    expect(writes[1]?.placements).toMatchObject({
      'placement-current': { compact: true },
    });
    expect(view.boardsGet).toHaveBeenCalledTimes(1);
    expect(view.placementsFindAll).toHaveBeenCalledTimes(1);
    expect(view.setNodes).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to arrange zone contents:',
      expect.anything()
    );
    consoleError.mockRestore();
  });

  it('bounds a repeatedly stale background Auto Zone pass without logs, toasts, or feedback writes', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = renderStaleRecovery({ auto: true, staleAttempts: 2 });

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(layoutWrites(view.boardsPatch)).toHaveLength(2);
    expect(view.boardsGet).toHaveBeenCalledTimes(1);
    expect(view.setNodes).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to arrange zone contents:',
      expect.anything()
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(layoutWrites(view.boardsPatch)).toHaveLength(2);
    consoleError.mockRestore();
  });

  it('reports one actionable failure when an explicit replan loses a second race', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = renderStaleRecovery({ staleAttempts: 2 });
    const zoneNode = view.result.current.getBoardObjectNodes().find((node) => node.id === zoneId);
    expect(zoneNode).toBeDefined();

    await act(async () => {
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)(zoneId);
    });

    expect(layoutWrites(view.boardsPatch)).toHaveLength(2);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith('The board changed again while arranging. Try again.');
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to arrange zone contents:',
      expect.anything()
    );
    consoleError.mockRestore();
  });

  it('lets an explicit Auto Zone action supersede its scheduled observer pass', async () => {
    vi.useFakeTimers();
    const view = renderStaleRecovery({ auto: true });
    const zoneNode = view.result.current.getBoardObjectNodes().find((node) => node.id === zoneId);
    expect(zoneNode).toBeDefined();

    await act(async () => {
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)(zoneId);
    });
    expect(layoutWrites(view.boardsPatch)).toHaveLength(2);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(layoutWrites(view.boardsPatch)).toHaveLength(2);
    expect(view.setNodes).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Minimal client whose `service('boards').patch` is a spy. reorderObject is the
 * only behavior exercised here, and it only touches `client` + `board`.
 */
function makeClient() {
  const patch = vi.fn().mockImplementation(mockBoardPatchResult);
  const service = vi.fn().mockReturnValue({ patch });
  const client = { service };
  return { client: client as never, patch, service };
}

function makeRoutedClient() {
  const boardsPatch = vi.fn().mockImplementation(mockBoardPatchResult);
  const boardObjectsPatch = vi.fn().mockResolvedValue({});
  const service = vi.fn((path: string) => ({
    patch: path === 'boards' ? boardsPatch : boardObjectsPatch,
  }));
  return { client: { service } as never, service, boardsPatch, boardObjectsPatch };
}

function mockBoardPatchResult(boardId: string, data: Record<string, unknown>) {
  if (data?._action !== 'applyLayout') return Promise.resolve({});
  const objects = (data.objects ?? {}) as Record<string, BoardObject>;
  const placements = data.placements as Record<
    string,
    {
      position: { x: number; y: number };
      size: { width: number; height: number };
      compact?: boolean;
    }
  >;
  return Promise.resolve({
    board: { board_id: boardId, objects },
    placements: Object.entries(placements ?? {}).map(([objectId, layout]) => ({
      object_id: objectId,
      board_id: boardId,
      entity_type: 'branch',
      created_at: '2026-01-01T00:00:00.000Z',
      ...layout,
    })),
    changed: true,
    changed_object_ids: Object.keys(objects),
    changed_placement_ids: Object.keys(placements ?? {}),
  });
}

function layoutWrites(patch: { mock: { calls: unknown[][] } }) {
  return patch.mock.calls
    .map((call) => call[1] as { _action?: string; objects?: object; placements?: object })
    .filter((write) => write?._action === 'applyLayout');
}

function layoutPlacements(patch: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return Object.assign({}, ...layoutWrites(patch).map((write) => write.placements ?? {}));
}

/** Like makeClient but `patch` rejects, to exercise the error path. */
function makeRejectingClient() {
  const patch = vi.fn().mockRejectedValue(new Error('network down'));
  const client = { service: vi.fn().mockReturnValue({ patch }) };
  return { client: client as never, patch };
}

function makeBoard(objects: Record<string, unknown>): Board {
  return { board_id: 'board-1', objects } as unknown as Board;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ConnectionProvider value={connectionState}>
    <AntApp>{children}</AntApp>
  </ConnectionProvider>
);

function renderReorder(board: Board, client: unknown, canEdit = true) {
  return renderHook(
    ({ effectiveCanEdit }) =>
      useBoardObjects({
        board,
        client: client as never,
        boardObjectsForBoard: [],
        nodes: [],
        setNodes: vi.fn(),
        deletedObjectsRef: { current: new Set<string>() },
        canEdit: effectiveCanEdit,
      }),
    { wrapper, initialProps: { effectiveCanEdit: canEdit } }
  );
}

describe('zone toolbar metadata', () => {
  it('reports geometric overlaps, layer no-ops, and effective edit permission', () => {
    const { client } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 200, height: 200, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 100, y: 100, width: 200, height: 200, label: 'B', zIndex: 110 },
      c: { type: 'zone', x: 500, y: 500, width: 200, height: 200, label: 'C', zIndex: 120 },
    });
    const { result } = renderReorder(board, client, false);

    const nodes = result.current.getBoardObjectNodes();
    const a = nodes.find((node) => node.id === 'a');
    const c = nodes.find((node) => node.id === 'c');

    expect(a?.data).toMatchObject({
      canEdit: false,
      overlappingZoneCount: 1,
      layerAvailability: { front: true, forward: true, backward: false, back: false },
    });
    expect(a?.draggable).toBe(false);
    expect(c?.data).toMatchObject({
      overlappingZoneCount: 0,
      layerAvailability: { front: false, forward: false, backward: true, back: true },
    });
  });

  it('passes effective edit permission to every structural object component', () => {
    const { client } = makeClient();
    const board = makeBoard({
      app: {
        type: 'app',
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        title: 'App',
        template: 'react',
        files: {},
      },
      artifact: {
        type: 'artifact',
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        artifact_id: 'artifact-1',
      },
      note: { type: 'markdown', x: 0, y: 0, width: 300, content: 'Note' },
    });
    const { result } = renderReorder(board, client, false);

    for (const node of result.current.getBoardObjectNodes()) {
      expect(node.data.canEdit).toBe(false);
      expect(node.draggable).toBe(false);
    }
  });
});

describe('updateObject', () => {
  it('returns false when the board patch rejects so modal callers stay open', async () => {
    const { client, patch } = makeRejectingClient();
    const note = {
      type: 'markdown',
      x: 0,
      y: 0,
      width: 300,
      content: 'Review',
    } as BoardObject;
    const board = makeBoard({ a: note });
    const { result } = renderReorder(board, client);
    const node = result.current.getBoardObjectNodes().find(({ id }) => id === 'a');
    const onUpdate = node?.data.onUpdate as (
      objectId: string,
      objectData: BoardObject
    ) => Promise<boolean>;

    await expect(onUpdate('a', { ...note, content: 'Updated' })).resolves.toBe(false);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith('Failed to save board object');
  });

  it('blocks stale update and delete callbacks after permission revocation', async () => {
    const { client, patch } = makeClient();
    const setNodes = vi.fn();
    const note = {
      type: 'markdown',
      x: 0,
      y: 0,
      width: 300,
      content: 'Review',
    } as BoardObject;
    const board = makeBoard({ a: note });
    const { result, rerender } = renderHook(
      ({ canEdit }) =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes: [],
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
          canEdit,
        }),
      { wrapper, initialProps: { canEdit: true } }
    );
    const data = result.current.getBoardObjectNodes()[0]?.data;
    const onUpdate = data.onUpdate as (
      objectId: string,
      objectData: BoardObject
    ) => Promise<boolean>;
    const onDelete = data.onDelete as (objectId: string) => Promise<void>;

    rerender({ canEdit: false });
    await expect(onUpdate('a', { ...note, content: 'Updated' })).resolves.toBe(false);
    await onDelete('a');

    expect(patch).not.toHaveBeenCalled();
    expect(setNodes).not.toHaveBeenCalled();
  });
});

describe('deleteArtifact', () => {
  it('blocks a stale lifecycle-delete callback after the connection gate closes', async () => {
    const { client, service } = makeClient();
    const board = makeBoard({
      artifact: {
        type: 'artifact',
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        artifact_id: 'artifact-1',
      },
    });
    const { result, rerender } = renderReorder(board, client);
    const onDeleteArtifact = result.current.getBoardObjectNodes()[0]?.data.onDeleteArtifact as (
      objectId: string,
      artifactId: string
    ) => Promise<void>;

    connectionState.connecting = true;
    rerender({ effectiveCanEdit: true });
    await onDeleteArtifact('artifact', 'artifact-1');

    expect(service).not.toHaveBeenCalled();
  });
});

describe('reorderObject', () => {
  it('"front" sends a single mergeObjectFields patch with the clamped zIndex', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 105 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toBe('board-1');
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 106 } },
    });
  });

  it('"forward" sends one mergeObjectFields patch touching BOTH swapped ids', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 105 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'forward');

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 105 }, b: { zIndex: 100 } },
    });
  });

  it('scopes peers to the SAME type — a zone does not rank against markdown', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 100 },
      m: { type: 'markdown', x: 0, y: 0, width: 1, content: '', zIndex: 300 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    // If the markdown (300) were a peer, the result would be 301. Scoping to
    // zones makes maxOther 100, so the tie breaks to 101.
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 101 } },
    });
  });

  it('"front" at an occupied ceiling pins the target at 499 and drops the occupant (never the card layer)', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 200 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 499 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    // Can't go to 500; pin target at the ceiling and push the occupant down so
    // the target still leads — both stay in-band.
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 499 }, b: { zIndex: 498 } },
    });
  });

  it('does nothing when the operation is a no-op (already at front)', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 110 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 100 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    expect(patch).not.toHaveBeenCalled();
  });

  it('surfaces a themed error (and does not throw) when the patch rejects', async () => {
    const { client, patch } = makeRejectingClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 105 },
    });
    const { result } = renderReorder(board, client);

    // Must resolve (swallow the rejection), not throw out of reorderObject.
    await expect(result.current.reorderObject('a', 'front')).resolves.toBeUndefined();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith('Failed to reorder zone');
  });

  it('coerces a non-finite base zIndex via sanitizeZIndex before computing (NaN → default 100 → 101)', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: Number.NaN },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 100 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    // NaN sanitizes to the zone default (100); tie with b (100) breaks to 101.
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 101 } },
    });
  });

  it('treats an out-of-band peer (600) as the ceiling (499) so the result stays in-band', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      a: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'A', zIndex: 100 },
      b: { type: 'zone', x: 0, y: 0, width: 1, height: 1, label: 'B', zIndex: 600 },
    });
    const { result } = renderReorder(board, client);

    await result.current.reorderObject('a', 'front');

    // sanitizeZIndex clamps the 600 peer to 499 (the ceiling), so "front" pins
    // the target at 499 and drops the occupant to 498 — never 601 / the card
    // (500) / comment (1000) layers.
    expect(patch.mock.calls[0][1]).toEqual({
      _action: 'mergeObjectFields',
      objects: { a: { zIndex: 499 }, b: { zIndex: 498 } },
    });
  });
});

describe('batchUpdateObjectPositions', () => {
  it('persists a mixed canvas selection as one complete board snapshot mutation', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const board = makeBoard({
      zone: { type: 'zone', x: 0, y: 0, width: 600, height: 400, label: 'Zone' },
      artifact: {
        type: 'artifact',
        artifact_id: 'artifact-1',
        x: 800,
        y: 0,
        width: 500,
        height: 300,
      },
    });
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes: [],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await result.current.batchUpdateObjectPositions({
      zone: { x: 80, y: 80, width: 720, height: 520 },
      artifact: { x: 840, y: 80, width: 500, height: 300 },
    });

    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(boardsPatch).toHaveBeenCalledWith('board-1', {
      _action: 'batchUpsertObjects',
      objects: {
        zone: {
          type: 'zone',
          x: 80,
          y: 80,
          width: 720,
          height: 520,
          label: 'Zone',
        },
        artifact: {
          type: 'artifact',
          artifact_id: 'artifact-1',
          x: 840,
          y: 80,
          width: 500,
          height: 300,
        },
      },
    });
  });
});

describe('arrangeZoneContents', () => {
  it.each([4, 12, 24])('persists a real %ipx child boundary gap', async (gap) => {
    const { client, boardsPatch } = makeRoutedClient();
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 900,
        height: 500,
        label: 'Fictional density',
        layout: { mode: 'manual', preset: 'grid', columns: 2, gap },
      },
    });
    const nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, width: 900, height: 500, data: {} },
      ...['left', 'right'].map(
        (id): Node => ({
          id,
          type: 'branchNode',
          parentId: 'zone',
          position: { x: 20, y: 100 },
          width: 380,
          height: 100,
          data: {},
        })
      ),
    ];
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-left',
              entity_type: 'branch',
              branch_id: 'left',
              zone_id: 'zone',
              position: { x: 20, y: 100 },
            },
            {
              object_id: 'placement-right',
              entity_type: 'branch',
              branch_id: 'right',
              zone_id: 'zone',
              position: { x: 20, y: 100 },
            },
          ] as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes().find((node) => node.id === 'zone');
    await act(async () => {
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    const placements = layoutPlacements(boardsPatch);
    const left = placements['placement-left'];
    const right = placements['placement-right'];
    const boundaryGap =
      right.position.x === left.position.x
        ? right.position.y - (left.position.y + left.size.height)
        : right.position.x - (left.position.x + left.size.width);
    expect(boundaryGap).toBe(gap);
  });

  it('reserves the scaled live title before packing a single child', async () => {
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 540,
        height: 500,
        label: 'Large title',
        fontSize: 48,
      },
    });
    const initialNodes: Node[] = [
      {
        id: 'zone',
        type: 'zone',
        position: { x: 0, y: 0 },
        data: { fontSize: 48 },
        width: 540,
        height: 500,
      },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 100 },
        data: {},
        width: 500,
        height: 240,
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const renderedZone = document.createElement('div');
    renderedZone.className = 'react-flow__node-zone';
    renderedZone.dataset.id = 'zone';
    renderedZone.getBoundingClientRect = () =>
      ({
        width: 270,
        height: 250,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 270,
        bottom: 250,
      }) as DOMRect;
    document.body.append(renderedZone);

    try {
      const { result } = renderHook(
        () =>
          useBoardObjects({
            board,
            client,
            boardObjectsForBoard: [
              {
                object_id: 'placement-branch',
                branch_id: 'branch-1',
                zone_id: 'zone',
                position: { x: 20, y: 100 },
              },
            ] as never,
            nodes: initialNodes,
            setNodes,
            deletedObjectsRef: { current: new Set<string>() },
          }),
        { wrapper }
      );

      const zoneNode = result.current.getBoardObjectNodes()[0];
      await act(async () => {
        await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)('zone');
      });

      expect(renderedNodes.find((node) => node.id === 'branch-1')?.position).toEqual({
        x: 20,
        y: 180,
      });
      expect(boardObjectsPatch).not.toHaveBeenCalled();
      expect(layoutPlacements(boardsPatch)['placement-branch']).toEqual({
        position: { x: 20, y: 180 },
        size: { width: 500, height: 240 },
      });
    } finally {
      renderedZone.remove();
    }
  });

  it('packs once, starts one motion, and persists one complete patch per child', async () => {
    const { client, patch } = makeClient();
    const onArrangeNodes = vi.fn();
    const onUserLayoutComplete = vi.fn();
    const board = makeBoard({
      zone: { type: 'zone', x: 0, y: 0, width: 900, height: 500, label: 'Zone' },
    });
    const initialNodes: Node[] = [
      {
        id: 'zone',
        type: 'zone',
        position: { x: 0, y: 0 },
        data: {},
        width: 900,
        height: 500,
      },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 200, y: 200 },
        data: {},
        width: 399,
        height: 179,
      },
      {
        id: 'card-card-1',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 220, y: 210 },
        data: {},
        width: 299,
        height: 99,
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-branch',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-1',
              position: { x: 200, y: 200 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-card',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'card-1',
              position: { x: 220, y: 210 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
          onArrangeNodes,
          onUserLayoutComplete,
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes()[0];
    await act(async () => {
      await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(renderedNodes.find((node) => node.id === 'branch-1')?.position).toEqual({
      x: 20,
      y: 100,
    });
    expect(renderedNodes.find((node) => node.id === 'card-card-1')?.position).toEqual({
      x: 20,
      y: 304,
    });
    expect(onArrangeNodes).toHaveBeenCalledTimes(1);
    expect(onArrangeNodes.mock.calls[0]?.[0].map((node: Node) => node.position)).toEqual([
      { x: 20, y: 100 },
      { x: 20, y: 304 },
      { x: 0, y: 0 },
    ]);
    expect(onArrangeNodes.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(onUserLayoutComplete).toHaveBeenCalledTimes(1);
    expect(onUserLayoutComplete).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'user', boardId: 'board-1', scope: 'zone' })
    );
    expect(patch).toHaveBeenCalledTimes(1);
    const placements = layoutPlacements(patch);
    expect(placements['placement-branch']).toEqual({
      position: { x: 20, y: 100 },
      size: { width: 400, height: 180 },
    });
    expect(placements['placement-card']).toEqual({
      position: { x: 20, y: 304 },
      size: { width: 300, height: 100 },
    });
    expect(showSuccess).toHaveBeenCalledWith(
      'Arranged 2 items in a non-overlapping compact cluster.'
    );
    for (const update of Object.values(placements) as Array<{
      position: { x: number; y: number };
      size: { width: number; height: number };
    }>) {
      expect(update.size.width % BOARD_GRID_SIZE).toBe(0);
      expect(update.size.height % BOARD_GRID_SIZE).toBe(0);
    }
  });

  it('packs measured worktrees, cards, artifacts, notes, and apps together inside the zone', async () => {
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const board = makeBoard({
      zone: { type: 'zone', x: 100, y: 100, width: 1400, height: 1100, label: 'Mixed' },
      artifact: {
        type: 'artifact',
        artifact_id: 'artifact-1',
        x: 700,
        y: 300,
        width: 260,
        height: 440,
      },
      note: { type: 'markdown', x: 980, y: 300, width: 320, content: 'A note' },
      app: {
        type: 'app',
        x: 700,
        y: 760,
        width: 360,
        height: 220,
        title: 'App',
        template: 'react',
        files: {},
      },
      locked: {
        type: 'artifact',
        artifact_id: 'artifact-locked',
        x: 1100,
        y: 760,
        width: 260,
        height: 220,
        locked: true,
      },
    });
    let renderedNodes: Node[] = [
      {
        id: 'zone',
        type: 'zone',
        position: { x: 100, y: 100 },
        data: {},
        width: 1400,
        height: 1100,
      },
      {
        id: 'branch',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 40, y: 120 },
        data: {},
        width: 520,
        height: 140,
      },
      {
        id: 'card-card',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 40, y: 300 },
        data: {},
        width: 280,
        height: 180,
      },
      {
        id: 'artifact',
        type: 'artifactNode',
        position: { x: 700, y: 300 },
        data: { objectId: 'artifact', width: 260, height: 440 },
        width: 260,
        height: 440,
      },
      {
        id: 'note',
        type: 'markdown',
        position: { x: 980, y: 300 },
        data: { objectId: 'note', width: 320 },
        width: 320,
        height: 180,
      },
      {
        id: 'app',
        type: 'appNode',
        position: { x: 700, y: 760 },
        data: { objectId: 'app', width: 360, height: 220 },
        width: 360,
        height: 220,
      },
      {
        id: 'locked',
        type: 'artifactNode',
        position: { x: 1100, y: 760 },
        data: { objectId: 'locked', width: 260, height: 220, locked: true },
        width: 260,
        height: 220,
      },
    ];
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-branch',
              branch_id: 'branch',
              zone_id: 'zone',
              position: { x: 40, y: 120 },
            },
            {
              object_id: 'placement-card',
              card_id: 'card',
              zone_id: 'zone',
              position: { x: 40, y: 300 },
            },
          ] as never,
          nodes: renderedNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes().find((node) => node.id === 'zone');
    expect(zoneNode).toBeDefined();
    await act(async () => {
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(boardObjectsPatch).not.toHaveBeenCalled();
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    const boardWrite = boardsPatch.mock.calls[0]?.[1] as {
      _action: string;
      objects: Record<string, { x: number; y: number }>;
    };
    expect(boardWrite._action).toBe('applyLayout');
    expect(Object.keys(layoutPlacements(boardsPatch)).sort()).toEqual([
      'placement-branch',
      'placement-card',
    ]);
    expect(Object.keys(boardWrite.objects).sort()).toEqual(['app', 'artifact', 'note', 'zone']);
    expect(boardWrite.objects.locked).toBeUndefined();

    const arranged = renderedNodes.filter((node) =>
      ['branch', 'card-card', 'artifact', 'note', 'app'].includes(node.id)
    );
    const relative = arranged.map((node) => ({
      id: node.id,
      x: node.parentId ? node.position.x : node.position.x - 100,
      y: node.parentId ? node.position.y : node.position.y - 100,
      width: Number(node.width),
      height: Number(node.height),
    }));
    for (const item of relative) {
      expect(item.x).toBeGreaterThanOrEqual(20);
      expect(item.y).toBeGreaterThanOrEqual(80);
      expect(item.x + item.width).toBeLessThanOrEqual(1400 - 20);
      expect(item.y + item.height).toBeLessThanOrEqual(1100 - 20);
    }
    for (const [index, left] of relative.entries()) {
      for (const right of relative.slice(index + 1)) {
        expect(
          left.x + left.width + 20 <= right.x ||
            right.x + right.width + 20 <= left.x ||
            left.y + left.height + 20 <= right.y ||
            right.y + right.height + 20 <= left.y
        ).toBe(true);
      }
    }
    expect(showSuccess).toHaveBeenCalledWith(
      'Arranged 5 items in a non-overlapping compact cluster.'
    );
  });

  it('submits the complete affected canvas snapshot when another child needs layout', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 620,
        height: 700,
        label: 'Mixed',
        layout: { mode: 'manual', preset: 'grid', columns: 1, sortBy: 'position', gap: 20 },
      },
      note: { type: 'markdown', x: 20, y: 100, width: 360, content: 'Stable note' },
    });
    const nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, width: 620, height: 700, data: {} },
      {
        id: 'note',
        type: 'markdown',
        position: { x: 20, y: 100 },
        width: 360,
        height: 100,
        data: { title: 'A note' },
      },
      {
        id: 'branch',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 400 },
        width: 500,
        height: 240,
        data: { branch: { name: 'B branch' } },
      },
    ];
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-branch',
              entity_type: 'branch',
              branch_id: 'branch',
              zone_id: 'zone',
              position: { x: 20, y: 400 },
              size: { width: 500, height: 240 },
            },
          ] as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes().find((node) => node.id === 'zone');
    await act(async () => {
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(layoutWrites(boardsPatch)).toHaveLength(1);
    expect(layoutWrites(boardsPatch)[0]?.objects).toEqual({
      zone: expect.objectContaining({ x: 0, y: 0, width: 540, height: 480 }),
      note: expect.objectContaining({ x: 20, y: 100, width: 360 }),
    });
    expect(layoutPlacements(boardsPatch)['placement-branch']).toEqual({
      position: { x: 20, y: 220 },
      size: { width: 500, height: 240 },
    });
  });

  it('uses the visible zone frame instead of overwriting it from a stale board snapshot', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        label: 'Moved',
        layout: { mode: 'auto', resize: 'height' },
      },
      artifact: {
        type: 'artifact',
        artifact_id: 'artifact-1',
        x: 1500,
        y: 1300,
        width: 300,
        height: 220,
      },
    });
    const nodes: Node[] = [
      {
        id: 'zone',
        type: 'zone',
        position: { x: 1000, y: 1000 },
        data: {},
        width: 900,
        height: 700,
      },
      {
        id: 'artifact',
        type: 'artifactNode',
        position: { x: 1500, y: 1300 },
        data: { objectId: 'artifact', width: 300, height: 220 },
        width: 300,
        height: 220,
      },
    ];
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    const zoneNode = result.current.getBoardObjectNodes().find((node) => node.id === 'zone');
    expect(zoneNode).toBeDefined();

    await act(async () => {
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(boardsPatch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'applyLayout',
        objects: expect.objectContaining({
          artifact: expect.objectContaining({ x: 1020, y: 1100 }),
          zone: expect.objectContaining({ x: 1000, y: 1000, width: 400, height: 340 }),
        }),
      })
    );
  });

  it('minimally shifts a newly covered zone and its canvas contents in the same grow write', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const board = makeBoard({
      grow: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 620,
        height: 120,
        label: 'Growing',
        layout: { mode: 'manual', resize: 'height', onOverflow: 'reflow_board' },
      },
      below: { type: 'zone', x: 0, y: 250, width: 620, height: 300, label: 'Below' },
      note: { type: 'markdown', x: 40, y: 300, width: 200, height: 100, content: 'Fictional' },
      far: { type: 'zone', x: 1200, y: 0, width: 400, height: 300, label: 'Far' },
    });
    const initialNodes: Node[] = [
      { id: 'grow', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 620, height: 120 },
      {
        id: 'branch-a',
        type: 'branchNode',
        parentId: 'grow',
        position: { x: 20, y: 100 },
        data: { branch: { name: 'Branch A' } },
        width: 500,
        height: 200,
      },
      { id: 'below', type: 'zone', position: { x: 0, y: 250 }, data: {}, width: 620, height: 300 },
      {
        id: 'note',
        type: 'markdown',
        position: { x: 40, y: 300 },
        data: {},
        width: 200,
        height: 100,
      },
      { id: 'far', type: 'zone', position: { x: 1200, y: 0 }, data: {}, width: 400, height: 300 },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const onArrangeNodes = vi.fn();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-a',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-a',
              zone_id: 'grow',
              position: { x: 20, y: 100 },
              size: { width: 500, height: 200 },
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
          onArrangeNodes,
        }),
      { wrapper }
    );

    await act(async () => {
      const zoneNode = result.current.getBoardObjectNodes().find((node) => node.id === 'grow');
      expect(zoneNode).toBeDefined();
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)('grow');
    });

    const write = boardsPatch.mock.calls[0]?.[1];
    const objects = write.objects as Record<string, { x: number; y: number; height: number }>;
    expect(write._action).toBe('applyLayout');
    expect(objects.grow.height).toBeGreaterThan(250);
    expect(objects.below.x).toBe(0);
    expect(objects.below.y).toBeGreaterThanOrEqual(objects.grow.height + BOARD_GRID_SIZE);
    expect(objects.note.y - 300).toBe(objects.below.y - 250);
    expect(objects.far).toBeUndefined();
    expect(renderedNodes.find((node) => node.id === 'below')?.position.y).toBe(objects.below.y);
    expect(onArrangeNodes).toHaveBeenCalledTimes(1);
  });

  it('moves a growing zone and its parented contents together rather than covering a locked root', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const board = makeBoard({
      grow: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 400,
        height: 120,
        label: 'Growing',
        layout: { mode: 'manual', resize: 'both', onOverflow: 'reflow_board' },
      },
      locked: {
        type: 'zone',
        x: 420,
        y: 0,
        width: 300,
        height: 300,
        label: 'Locked',
        locked: true,
      },
    });
    const initialNodes: Node[] = [
      { id: 'grow', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 400, height: 120 },
      {
        id: 'branch-a',
        type: 'branchNode',
        parentId: 'grow',
        position: { x: 20, y: 100 },
        data: { branch: { name: 'Branch A' } },
        width: 500,
        height: 200,
      },
      {
        id: 'locked',
        type: 'zone',
        position: { x: 420, y: 0 },
        data: { locked: true },
        width: 300,
        height: 300,
      },
    ];
    const setNodes = vi.fn();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-a',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-a',
              zone_id: 'grow',
              position: { x: 20, y: 100 },
              size: { width: 500, height: 200 },
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      const zoneNode = result.current.getBoardObjectNodes().find((node) => node.id === 'grow');
      expect(zoneNode).toBeDefined();
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)('grow');
    });

    const write = boardsPatch.mock.calls[0]?.[1];
    const objects = write.objects as Record<string, { x: number; y: number; width: number }>;
    expect(write._action).toBe('applyLayout');
    expect(objects.grow.x + objects.grow.width).toBeLessThanOrEqual(420 - BOARD_GRID_SIZE);
    expect(objects.locked).toBeUndefined();
    expect(write.placements['placement-a'].position).toEqual({ x: 20, y: 100 });
    expect(setNodes).toHaveBeenCalledTimes(1);
  });

  it('uses the live rendered height when dynamic branch content exceeds React Flow dimensions', async () => {
    const renderedBranch = document.createElement('div');
    renderedBranch.className = 'react-flow__node';
    renderedBranch.dataset.id = 'branch-1';
    Object.defineProperties(renderedBranch, {
      offsetWidth: { configurable: true, value: 500 },
      offsetHeight: { configurable: true, value: 236 },
    });
    const renderedCard = document.createElement('div');
    renderedCard.className = 'react-flow__node';
    renderedCard.dataset.id = 'card-card-1';
    Object.defineProperties(renderedCard, {
      offsetWidth: { configurable: true, value: 380 },
      offsetHeight: { configurable: true, value: 85 },
    });
    document.body.append(renderedBranch, renderedCard);

    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: { type: 'zone', x: 0, y: 0, width: 620, height: 1200, label: 'Zone' },
    });
    const initialNodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 620, height: 1200 },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 60 },
        data: {},
        width: 500,
        height: 200,
      },
      {
        id: 'card-card-1',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 20, y: 300 },
        data: {},
        width: 380,
        height: 120,
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-branch',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-1',
              position: { x: 20, y: 60 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-card',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'card-1',
              position: { x: 20, y: 300 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes()[0];
    await act(async () => {
      await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(renderedNodes.find((node) => node.id === 'branch-1')?.position).toEqual({
      x: 20,
      y: 100,
    });
    expect(renderedNodes.find((node) => node.id === 'card-card-1')?.position).toEqual({
      x: 20,
      y: 364,
    });
    const placements = layoutPlacements(patch);
    expect(placements['placement-branch']).toEqual({
      position: { x: 20, y: 100 },
      size: { width: 500, height: 240 },
    });
    expect(placements['placement-card']).toEqual({
      position: { x: 20, y: 364 },
      size: { width: 380, height: 100 },
    });

    renderedBranch.remove();
    renderedCard.remove();
  });

  it('uses rendered headers while growing a too-small zone instead of stacking', async () => {
    const renderedBranch = document.createElement('div');
    renderedBranch.className = 'react-flow__node';
    renderedBranch.dataset.id = 'branch-1';
    const branchHeader = document.createElement('div');
    branchHeader.dataset.zoneStackHeader = '';
    Object.defineProperties(branchHeader, {
      offsetHeight: { configurable: true, value: 61 },
      scrollHeight: { configurable: true, value: 61 },
    });
    renderedBranch.append(branchHeader);
    const renderedCard = document.createElement('div');
    renderedCard.className = 'react-flow__node';
    renderedCard.dataset.id = 'branch-2';
    const cardHeader = document.createElement('div');
    cardHeader.dataset.zoneStackHeader = '';
    Object.defineProperties(cardHeader, {
      offsetHeight: { configurable: true, value: 41 },
      scrollHeight: { configurable: true, value: 41 },
    });
    renderedCard.append(cardHeader);
    document.body.append(renderedBranch, renderedCard);

    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: { type: 'zone', x: 0, y: 0, width: 500, height: 200, label: 'Zone' },
    });
    const initialNodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 500, height: 200 },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 20 },
        data: {},
        width: 400,
        height: 180,
      },
      {
        id: 'branch-2',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 40, y: 40 },
        data: {},
        width: 300,
        height: 100,
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-branch',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-1',
              position: { x: 20, y: 20 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-branch-2',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-2',
              position: { x: 40, y: 40 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes()[0];
    await act(async () => {
      await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    const stackedBranch = renderedNodes.find((node) => node.id === 'branch-1');
    const stackedCard = renderedNodes.find((node) => node.id === 'branch-2');
    expect(stackedBranch?.position).toEqual({ x: 20, y: 100 });
    expect(stackedCard?.position).toEqual({ x: 20, y: 304 });
    expect(
      (stackedCard?.position.y ?? 0) - (stackedBranch?.position.y ?? 0)
    ).toBeGreaterThanOrEqual(stackedBranch?.height ?? 0);
    expect(stackedBranch?.className ?? '').not.toContain('auto-zone-stack-item');
    expect(result.current.zoneStackByNodeId.size).toBe(0);
    const placements = layoutPlacements(patch);
    expect(placements['placement-branch']).toEqual(
      expect.objectContaining({ position: { x: 20, y: 100 } })
    );
    expect(placements['placement-branch-2']).toEqual(
      expect.objectContaining({ position: { x: 20, y: 304 } })
    );
    expect(layoutWrites(patch)[0]).toEqual(
      expect.objectContaining({
        objects: { zone: expect.objectContaining({ width: 440, height: 440 }) },
      })
    );
    expect(showWarning).not.toHaveBeenCalled();

    renderedBranch.remove();
    renderedCard.remove();
  });

  it('grows automatic zones promptly with one visible motion instead of stacking', async () => {
    vi.useFakeTimers();
    const cardNodeIds = ['branch-1', 'branch-2', 'branch-3'];
    const renderedCards = cardNodeIds.map((id) => {
      const renderedCard = document.createElement('div');
      renderedCard.className = 'react-flow__node';
      renderedCard.dataset.id = id;
      const header = document.createElement('div');
      header.dataset.zoneStackHeader = '';
      Object.defineProperties(header, {
        offsetHeight: { configurable: true, value: 41 },
        scrollHeight: { configurable: true, value: 41 },
      });
      renderedCard.append(header);
      document.body.append(renderedCard);
      return renderedCard;
    });
    const { client, patch } = makeClient();
    const nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 500, height: 200 },
      ...cardNodeIds.map((id, index) => ({
        id,
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 20 + index * 60 },
        data: {},
        width: 380,
        height: 120,
      })),
    ];

    let renderedNodes = nodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const onArrangeNodes = vi.fn();
    renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({
            zone: {
              type: 'zone',
              x: 0,
              y: 0,
              width: 500,
              height: 200,
              label: 'Zone',
              layout: { mode: 'auto', preset: 'grid', autoResizeHeight: false },
            },
          }),
          client,
          boardObjectsForBoard: cardNodeIds.map((_, index) => ({
            object_id: `placement-branch-${index + 1}`,
            board_id: 'board-1',
            entity_type: 'branch',
            branch_id: `branch-${index + 1}`,
            position: { x: 20, y: 20 + index * 60 },
            zone_id: 'zone',
            created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
          })) as never,
          nodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
          onArrangeNodes,
        }),
      { wrapper }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(showWarning).not.toHaveBeenCalled();
    const zoneWrite = patch.mock.calls.find(([id]) => id === 'board-1')?.[1];
    expect(zoneWrite).toMatchObject({
      _action: 'applyLayout',
      objects: { zone: expect.objectContaining({ height: expect.any(Number) }) },
    });
    expect(zoneWrite.objects.zone.height).toBeGreaterThan(200);
    expect(zoneWrite.objects.zone.height % BOARD_GRID_SIZE).toBe(0);
    expect(onArrangeNodes).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(patch.mock.calls.filter(([id]) => id === 'board-1')).toHaveLength(1);
    expect(onArrangeNodes).toHaveBeenCalledTimes(1);
    for (const node of renderedNodes.filter((candidate) => cardNodeIds.includes(candidate.id))) {
      expect(node.style?.['--agor-deal-duration' as never]).toBeUndefined();
    }
    for (const renderedCard of renderedCards) renderedCard.remove();
  });

  it('uses List ordering while preserving expanded body-card density', async () => {
    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 620,
        height: 900,
        label: 'Zone',
        layout: {
          mode: 'manual',
          preset: 'compact_list',
          sortBy: 'updated',
          sortDirection: 'desc',
          autoResizeHeight: true,
        },
      },
    });
    const initialNodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 620, height: 900 },
      {
        id: 'card-older',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 200, y: 300 },
        data: {
          card: {
            title: 'Older',
            description: 'Fictional body',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        },
        width: 380,
        height: 220,
      },
      {
        id: 'card-newer',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 200, y: 100 },
        data: {
          card: {
            title: 'Newer',
            description: 'Fictional body',
            updated_at: '2026-02-01T00:00:00.000Z',
          },
        },
        width: 380,
        height: 260,
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-older',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'older',
              position: { x: 200, y: 300 },
              zone_id: 'zone',
              compact: false,
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-newer',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'newer',
              position: { x: 200, y: 100 },
              zone_id: 'zone',
              compact: false,
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    const zoneNode = result.current.getBoardObjectNodes()[0];
    await act(async () => {
      await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)('zone');
    });

    expect(renderedNodes.find((node) => node.id === 'card-newer')?.position.y).toBe(100);
    expect(renderedNodes.find((node) => node.id === 'card-older')?.position.y).toBe(384);
    const placements = layoutPlacements(patch);
    expect(placements['placement-newer']).toEqual({
      position: { x: 20, y: 100 },
      size: { width: 380, height: 260 },
    });
    expect(placements['placement-older']).toEqual({
      position: { x: 20, y: 384 },
      size: { width: 380, height: 220 },
    });
    expect(Object.values(placements).every((placement) => !('compact' in placement))).toBe(true);
    expect(layoutWrites(patch)).toHaveLength(1);
  });

  it('atomically applies explicit Collapse geometry to worktrees and body cards', async () => {
    const { client, patch } = makeClient();
    const compactLayout = {
      mode: 'auto',
      preset: 'compact_list',
      density: 'collapse',
      sortBy: 'position',
      sortDirection: 'asc',
      gap: 8,
      autoResizeHeight: false,
    } as const;
    const board = makeBoard({
      'cards-zone': {
        type: 'zone',
        x: 0,
        y: 0,
        width: 620,
        height: 400,
        label: 'Cards',
        layout: compactLayout,
      },
      'branches-zone': {
        type: 'zone',
        x: 700,
        y: 0,
        width: 1600,
        height: 400,
        label: 'Worktrees',
        layout: compactLayout,
      },
    });
    const initialNodes: Node[] = [
      {
        id: 'cards-zone',
        type: 'zone',
        position: { x: 0, y: 0 },
        data: {},
        width: 620,
        height: 400,
      },
      {
        id: 'branches-zone',
        type: 'zone',
        position: { x: 700, y: 0 },
        data: {},
        width: 1600,
        height: 400,
      },
      {
        id: 'card-card-1',
        type: 'cardNode',
        parentId: 'cards-zone',
        position: { x: 31, y: 72 },
        data: { card: { title: 'Tracking card', description: 'Rendered body' } },
        width: 304,
        height: 60,
      },
      {
        id: 'branch-1',
        type: 'branchNode',
        parentId: 'branches-zone',
        position: { x: 11, y: 47 },
        data: {},
        width: 580,
        height: 100,
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-card',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'card-1',
              position: { x: 31, y: 72 },
              zone_id: 'cards-zone',
              compact: false,
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-branch',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch-1',
              position: { x: 11, y: 47 },
              zone_id: 'branches-zone',
              compact: false,
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    for (const zoneNode of result.current.getBoardObjectNodes()) {
      await act(async () => {
        await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)(zoneNode.id);
      });
    }

    const card = renderedNodes.find((node) => node.id === 'card-card-1');
    const branch = renderedNodes.find((node) => node.id === 'branch-1');
    expect(card).toMatchObject({ position: { x: 20, y: 100 }, width: 320, height: 60 });
    expect(branch).toMatchObject({ position: { x: 20, y: 100 }, width: 580, height: 100 });
    const placements = layoutPlacements(patch);
    expect(placements['placement-card']).toEqual(
      expect.objectContaining({ size: { width: 320, height: 60 }, compact: true })
    );
    expect(placements['placement-branch']).toEqual(
      expect.objectContaining({ size: { width: 580, height: 100 }, compact: true })
    );
  });

  it('automatically reapplies a persisted zone policy when observed content changes', async () => {
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 0,
        y: 0,
        width: 900,
        height: 500,
        label: 'Zone',
        layout: {
          mode: 'auto',
          preset: 'grid',
          sortBy: 'updated',
          sortDirection: 'desc',
          autoResizeHeight: false,
        },
      },
    });
    let nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, width: 900, height: 500 },
      {
        id: 'card-older',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 200, y: 200 },
        data: { card: { title: 'Older', updated_at: '2026-01-01T00:00:00.000Z' } },
        width: 300,
        height: 100,
      },
      {
        id: 'card-newer',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 220, y: 210 },
        data: { card: { title: 'Newer', updated_at: '2026-02-01T00:00:00.000Z' } },
        width: 300,
        height: 100,
      },
    ];
    const { rerender, unmount } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-older',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'older',
              position: { x: 200, y: 200 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
            {
              object_id: 'placement-newer',
              board_id: 'board-1',
              entity_type: 'card',
              card_id: 'newer',
              position: { x: 220, y: 210 },
              zone_id: 'zone',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    const placements = layoutPlacements(patch);
    expect(placements['placement-newer']).toEqual({
      position: { x: 20, y: 100 },
      size: { width: 300, height: 100 },
    });
    expect(placements['placement-older']).toEqual({
      position: { x: 20, y: 224 },
      size: { width: 300, height: 100 },
    });

    const patchCountAfterFirstPass = patch.mock.calls.length;
    nodes = nodes.map((node) =>
      node.id === 'card-newer'
        ? { ...node, position: { x: 20, y: 100 } }
        : node.id === 'card-older'
          ? { ...node, position: { x: 20, y: 220 } }
          : node
    );
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(patch).toHaveBeenCalledTimes(patchCountAfterFirstPass);
    unmount();
  });

  it('maintains a contained artifact once and consumes its realtime echo without churn', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch } = makeRoutedClient();
    const zone = {
      type: 'zone' as const,
      x: 100,
      y: 100,
      width: 900,
      height: 700,
      label: 'Automatic',
      layout: { mode: 'auto' as const },
    };
    const artifact = {
      type: 'artifact' as const,
      artifact_id: 'artifact-1',
      x: 600,
      y: 340,
      width: 300,
      height: 220,
    };
    let board = makeBoard({ zone });
    let nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 100, y: 100 }, data: {}, width: 900, height: 700 },
    ];
    const { rerender } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(boardsPatch).not.toHaveBeenCalled();

    board = makeBoard({ zone, artifact });
    nodes = [
      ...nodes,
      {
        id: 'artifact',
        type: 'artifactNode',
        position: { x: artifact.x, y: artifact.y },
        data: { objectId: 'artifact', width: artifact.width, height: artifact.height },
        width: artifact.width,
        height: artifact.height,
      },
    ];
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    const firstWrite = boardsPatch.mock.calls[0]?.[1] as {
      objects: Record<string, { x: number; y: number }>;
    };
    const persistedArtifact = firstWrite.objects.artifact;
    expect(persistedArtifact).toBeDefined();

    board = makeBoard({ zone, artifact: persistedArtifact });
    nodes = nodes.map((node) =>
      node.id === 'artifact'
        ? { ...node, position: { x: persistedArtifact!.x, y: persistedArtifact!.y } }
        : node
    );
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(showWarning).not.toHaveBeenCalled();
  });

  it('corrects one material note move once in a mixed Auto Zone and consumes the durable target', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch } = makeRoutedClient();
    const zone = {
      type: 'zone' as const,
      x: 1200,
      y: 400,
      width: 760,
      height: 900,
      label: 'Mixed review',
      layout: {
        mode: 'auto' as const,
        preset: 'grid' as const,
        sortBy: 'position' as const,
        sortDirection: 'asc' as const,
        columns: 1,
        gap: 20,
        autoResizeHeight: true,
        resize: 'height' as const,
      },
    };
    const note = {
      type: 'markdown' as const,
      x: 1220,
      y: 760,
      width: 320,
      content: '# Material note\n\nDurable mixed content.',
    };
    let board = makeBoard({ zone, note });
    let placements = [
      {
        object_id: 'placement-worktree',
        board_id: 'board-1',
        entity_type: 'branch',
        branch_id: 'worktree',
        zone_id: 'zone',
        position: { x: 20, y: 100 },
        size: { width: 500, height: 240 },
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        object_id: 'placement-card',
        board_id: 'board-1',
        entity_type: 'card',
        card_id: 'card',
        zone_id: 'zone',
        position: { x: 20, y: 680 },
        size: { width: 380, height: 100 },
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    let nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: zone.x, y: zone.y }, data: {}, ...zone },
      {
        id: 'worktree',
        type: 'branchNode',
        parentId: 'zone',
        position: placements[0]!.position,
        data: { branch: { name: 'Worktree' } },
      },
      {
        id: 'card-card',
        type: 'cardNode',
        parentId: 'zone',
        position: placements[1]!.position,
        data: { card: { title: 'Card', data: {} } },
      },
      {
        id: 'note',
        type: 'markdown',
        position: { x: note.x, y: note.y },
        width: note.width,
        height: 300,
        data: { objectId: 'note', width: note.width, height: 300 },
      },
    ];
    const measured = document.createElement('div');
    measured.className = 'react-flow__node';
    measured.dataset.id = 'note';
    document.body.append(measured);
    const setMeasuredHeight = (height: number) => {
      Object.defineProperties(measured, {
        offsetWidth: { configurable: true, value: 320 },
        scrollWidth: { configurable: true, value: 320 },
        offsetHeight: { configurable: true, value: height },
        scrollHeight: { configurable: true, value: height },
      });
    };
    setMeasuredHeight(300);
    const view = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: placements as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    const applyWrite = (write: {
      objects: Record<string, BoardObject>;
      placements: Record<
        string,
        { position: { x: number; y: number }; size: { width: number; height: number } }
      >;
    }) => {
      board = {
        ...board,
        objects: { ...board.objects, ...write.objects },
      } as Board;
      placements = placements.map((placement) => ({
        ...placement,
        ...(write.placements[placement.object_id] ?? {}),
      }));
      nodes = nodes.map((node) => {
        const object = write.objects[node.id];
        if (object) {
          return {
            ...node,
            position: { x: object.x, y: object.y },
            ...('width' in object ? { width: object.width } : {}),
            ...('height' in object ? { height: object.height } : {}),
          };
        }
        const placement = placements.find(
          (candidate) =>
            candidate.branch_id === node.id ||
            (candidate.card_id && `card-${candidate.card_id}` === node.id)
        );
        return placement ? { ...node, position: placement.position } : node;
      });
    };

    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(boardsPatch).not.toHaveBeenCalled();

    const durableNote = board.objects!.note as BoardObject & { y: number };
    board = makeBoard({ ...board.objects, note: { ...durableNote, y: durableNote.y + 80 } });
    nodes = nodes.map((node) =>
      node.id === 'note'
        ? { ...node, position: { x: node.position.x, y: node.position.y + 80 } }
        : node
    );
    view.rerender();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    const correction = boardsPatch.mock.calls[0]![1];
    expect(correction.objects.note.y).toBe(durableNote.y);
    expect(Object.keys(correction.objects).sort()).toEqual(['note', 'zone']);
    expect(Object.keys(correction.placements).sort()).toEqual([
      'placement-card',
      'placement-worktree',
    ]);
    applyWrite(correction);

    for (let cycle = 0; cycle < 8; cycle += 1) {
      setMeasuredHeight(cycle % 2 === 0 ? 280 : 340);
      board = makeBoard(
        Object.fromEntries(
          Object.entries(board.objects ?? {}).map(([id, object]) => [id, { ...object }])
        )
      );
      nodes = [...nodes].reverse().map((node) => ({ ...node, data: { ...node.data } }));
      placements = placements.map((placement) => ({
        ...placement,
        position: { ...placement.position },
        size: placement.size && { ...placement.size },
      }));
      view.rerender();
      await act(async () => vi.advanceTimersByTimeAsync(500));
    }

    expect(boardsPatch).toHaveBeenCalledTimes(1);
    view.unmount();
    setMeasuredHeight(300);

    const reloaded = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: placements as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    measured.remove();
    reloaded.unmount();
  });

  it('allows only the current board lease owner to write across acquisition and route races', async () => {
    vi.useFakeTimers();
    let tail = Promise.resolve();
    let acquisitionCount = 0;
    let resolveOwnerAcquired!: () => void;
    let resolveObserverAcquired!: () => void;
    const ownerAcquired = new Promise<void>((resolve) => {
      resolveOwnerAcquired = resolve;
    });
    const observerAcquired = new Promise<void>((resolve) => {
      resolveObserverAcquired = resolve;
    });
    const locks = {
      request: async (
        _name: string,
        options: { signal: AbortSignal },
        callback: () => Promise<void>
      ) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        if (!options.signal.aborted) {
          acquisitionCount += 1;
          const held = callback();
          if (acquisitionCount === 1) resolveOwnerAcquired();
          if (acquisitionCount === 2) resolveObserverAcquired();
          await held;
        }
        release();
      },
    };
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });

    const zone = {
      type: 'zone' as const,
      x: 0,
      y: 0,
      width: 620,
      height: 500,
      label: 'Leased',
      layout: { mode: 'auto' as const, preset: 'grid' as const },
    };
    const artifact = {
      type: 'artifact' as const,
      artifact_id: 'artifact-1',
      x: 400,
      y: 300,
      width: 300,
      height: 220,
    };
    let ownerBoard = makeBoard({ zone, artifact });
    let ownerNodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, width: 620, height: 500, data: {} },
      {
        id: 'artifact',
        type: 'artifactNode',
        position: { x: artifact.x, y: artifact.y },
        width: artifact.width,
        height: artifact.height,
        data: { objectId: 'artifact', width: artifact.width, height: artifact.height },
      },
    ];
    const ownerClient = makeRoutedClient();
    const observerClient = makeRoutedClient();
    const owner = renderHook(
      () =>
        useBoardObjects({
          board: ownerBoard,
          client: ownerClient.client,
          boardObjectsForBoard: [],
          nodes: ownerNodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    const observer = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ zone, artifact }),
          client: observerClient.client,
          boardObjectsForBoard: [],
          nodes: ownerNodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await ownerAcquired;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(ownerClient.boardsPatch).toHaveBeenCalledTimes(1);
    expect(observerClient.boardsPatch).not.toHaveBeenCalled();

    // Queue an owner observation, then change boards before its delay expires.
    // The old lease token must not be reinterpreted as ownership on the new route.
    ownerNodes = ownerNodes.map((node) =>
      node.id === 'artifact'
        ? { ...node, position: { x: node.position.x, y: node.position.y + 80 } }
        : node
    );
    owner.rerender();
    ownerBoard = {
      ...makeBoard({ zone: { ...zone, layout: { ...zone.layout, mode: 'manual' as const } } }),
      board_id: 'board-2',
    } as Board;
    ownerNodes = [];
    owner.rerender();

    await act(async () => {
      await observerAcquired;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(ownerClient.boardsPatch).toHaveBeenCalledTimes(1);
    expect(observerClient.boardsPatch).not.toHaveBeenCalled();

    owner.unmount();
    observer.unmount();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(navigator, 'locks');
  });

  it('keeps a measured single-child Auto Zone stable across observer and realtime rebuilds', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch } = makeRoutedClient();
    const zone = {
      type: 'zone' as const,
      x: 660,
      y: 1280,
      width: 620,
      height: 500,
      label: 'Single Auto Zone',
      fontSize: 20,
      layout: {
        mode: 'auto' as const,
        preset: 'grid' as const,
        sortBy: 'title' as const,
        sortDirection: 'asc' as const,
        columns: 3,
        gap: 24,
        autoResizeHeight: true,
        resize: 'both' as const,
        onOverflow: 'report' as const,
      },
    };
    const note = {
      type: 'markdown' as const,
      x: 680,
      y: 1380,
      width: 360,
      content: '# One item\n\nMeasured content.',
    };
    let board = makeBoard({ zone, note });
    let nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: zone.x, y: zone.y }, data: {}, ...zone },
      {
        id: 'note',
        type: 'markdown',
        position: { x: note.x, y: note.y },
        data: { objectId: 'note', width: note.width },
      },
    ];
    const measured = document.createElement('div');
    measured.className = 'react-flow__node';
    measured.dataset.id = 'note';
    for (const [key, value] of [
      ['offsetWidth', 360],
      ['scrollWidth', 360],
      ['offsetHeight', 244],
      ['scrollHeight', 244],
    ] as const) {
      Object.defineProperty(measured, key, { configurable: true, value });
    }
    document.body.append(measured);
    const renderedZone = document.createElement('div');
    renderedZone.className = 'react-flow__node-zone';
    renderedZone.dataset.id = 'zone';
    renderedZone.getBoundingClientRect = () => ({ width: 310, height: 250 }) as DOMRect;
    document.body.append(renderedZone);

    const setNodes = vi.fn();
    const view = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(500));
      // Simulate the production board/node rebuild caused by an unrelated
      // realtime event. Object identity and node order may change, geometry may not.
      board = makeBoard({ note: { ...note }, zone: { ...zone } });
      nodes = [...nodes].reverse().map((node) => ({ ...node, data: { ...node.data } }));
      view.rerender();
    }

    expect(boardsPatch).not.toHaveBeenCalled();
    expect(setNodes).not.toHaveBeenCalled();
    measured.remove();
    renderedZone.remove();
    view.unmount();
  });

  it('compares measured worktree output with durable geometry across realtime cycles', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const zone = {
      type: 'zone' as const,
      x: 0,
      y: 0,
      width: 620,
      height: 500,
      label: 'Measured worktree',
      fontSize: 48,
      layout: { mode: 'auto' as const, preset: 'grid' as const },
    };
    let board = makeBoard({ zone });
    let nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, ...zone },
      {
        id: 'branch',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 120 },
        // React Flow's declarative fallback differs from the hydrated DOM.
        width: 380,
        height: 120,
        data: { branch: { name: 'Hydrated worktree' } },
      },
    ];
    const measured = document.createElement('div');
    measured.className = 'react-flow__node';
    measured.dataset.id = 'branch';
    Object.defineProperties(measured, {
      offsetWidth: { configurable: true, value: 500 },
      scrollWidth: { configurable: true, value: 500 },
      offsetHeight: { configurable: true, value: 236 },
      scrollHeight: { configurable: true, value: 236 },
    });
    const renderedZone = document.createElement('div');
    renderedZone.className = 'react-flow__node-zone';
    renderedZone.dataset.id = 'zone';
    renderedZone.getBoundingClientRect = () => ({ width: 310 }) as DOMRect;
    document.body.append(measured, renderedZone);

    const view = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-branch',
              board_id: 'board-1',
              entity_type: 'branch',
              branch_id: 'branch',
              zone_id: 'zone',
              position: { x: 20, y: 120 },
              size: { width: 500, height: 240 },
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ] as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(500));
      board = makeBoard({ zone: { ...zone } });
      nodes = [...nodes].reverse().map((node) => ({ ...node, data: { ...node.data } }));
      view.rerender();
    }

    expect(boardsPatch).not.toHaveBeenCalled();
    expect(boardObjectsPatch).not.toHaveBeenCalled();
    measured.remove();
    renderedZone.remove();
    view.unmount();
  });

  it('keeps durable canvas frames stable when hydrated DOM measurements alternate', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch } = makeRoutedClient();
    const zone = {
      type: 'zone' as const,
      x: 0,
      y: 0,
      width: 620,
      height: 800,
      label: 'Durable apps',
      layout: { mode: 'auto' as const, preset: 'grid' as const, columns: 1, gap: 20 },
    };
    const first = {
      type: 'app' as const,
      x: 20,
      y: 100,
      width: 500,
      height: 300,
      title: 'First',
      template: 'react' as const,
      files: {},
    };
    const second = {
      ...first,
      y: 420,
      height: 200,
      title: 'Second',
    };
    let board = makeBoard({ zone, first, second });
    let nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, data: {}, ...zone },
      {
        id: 'first',
        type: 'appNode',
        position: { x: first.x, y: first.y },
        data: { objectId: 'first', width: first.width, height: first.height },
      },
      {
        id: 'second',
        type: 'appNode',
        position: { x: second.x, y: second.y },
        data: { objectId: 'second', width: second.width, height: second.height },
      },
    ];
    const measured = document.createElement('div');
    measured.className = 'react-flow__node';
    measured.dataset.id = 'first';
    document.body.append(measured);
    const setMeasurement = (height: number) => {
      Object.defineProperties(measured, {
        offsetWidth: { configurable: true, value: 500 },
        scrollWidth: { configurable: true, value: 500 },
        offsetHeight: { configurable: true, value: height },
        scrollHeight: { configurable: true, value: height },
      });
    };
    setMeasurement(340);

    const view = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(500));
      setMeasurement(cycle % 2 === 0 ? 300 : 340);
      board = makeBoard({ zone: { ...zone }, first: { ...first }, second: { ...second } });
      nodes = nodes.map((node) => ({ ...node, data: { ...node.data } }));
      view.rerender();
    }

    expect(boardsPatch).not.toHaveBeenCalled();
    measured.remove();
    view.unmount();
  });
});

describe('direct manipulation of automatic zones', () => {
  const zoneId = 'zone-1';
  const autoZone = {
    type: 'zone',
    x: 0,
    y: 0,
    width: 620,
    height: 500,
    label: 'Automatic',
    layout: {
      mode: 'auto',
      preset: 'compact_list',
      sortBy: 'position',
      sortDirection: 'asc',
      gap: 24,
      autoResizeHeight: false,
    },
  };
  const placement = {
    object_id: 'placement-branch',
    board_id: 'board-1',
    entity_type: 'branch',
    branch_id: 'branch-1',
    position: { x: 200, y: 200 },
    zone_id: zoneId,
    compact: true,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const child: Node = {
    id: 'branch-1',
    type: 'branchNode',
    parentId: zoneId,
    position: { x: 200, y: 200 },
    width: 380,
    height: 120,
    data: {},
  };

  function renderInteraction(
    board: Board,
    client: unknown,
    nodes: Node[] = [
      { id: zoneId, type: 'zone', position: { x: 0, y: 0 }, width: 620, height: 500, data: {} },
      child,
    ]
  ) {
    return renderHook(
      () =>
        useBoardObjects({
          board,
          client: client as never,
          boardObjectsForBoard: [placement] as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
  }

  it('persists manual mode before expanding a worktree and blocks the pending compact-list pass', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const { result } = renderInteraction(makeBoard({ [zoneId]: autoZone }), client);

    await act(async () => {
      await result.current.setPlacementCompact(placement as never, false);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(boardsPatch).toHaveBeenCalledWith('board-1', {
      _action: 'upsertObject',
      objectId: zoneId,
      objectData: expect.objectContaining({
        type: 'zone',
        layout: expect.objectContaining({ mode: 'manual', preset: 'compact_list' }),
      }),
    });
    expect(boardObjectsPatch).toHaveBeenCalledTimes(1);
    expect(boardObjectsPatch).toHaveBeenCalledWith('placement-branch', { compact: false });
    expect(boardsPatch.mock.invocationCallOrder[0]).toBeLessThan(
      boardObjectsPatch.mock.invocationCallOrder[0]
    );
  });

  it('also demotes before the zone-wide density control changes its contents', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const { result } = renderInteraction(makeBoard({ [zoneId]: autoZone }), client);

    await act(async () => {
      await result.current.setZoneContentsCompact(zoneId, false);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(boardsPatch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'upsertObject',
        objectId: zoneId,
        objectData: expect.objectContaining({
          layout: expect.objectContaining({ mode: 'manual' }),
        }),
      })
    );
    expect(boardObjectsPatch).toHaveBeenCalledTimes(1);
    expect(boardObjectsPatch).toHaveBeenCalledWith('placement-branch', { compact: false });
  });

  it('uses ordinary density controls after grow-to-fit packing rather than transient stacks', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const secondPlacement = {
      ...placement,
      object_id: 'placement-branch-2',
      branch_id: 'branch-2',
      position: { x: 220, y: 220 },
    };
    const initialNodes: Node[] = [
      { id: zoneId, type: 'zone', position: { x: 0, y: 0 }, width: 620, height: 200, data: {} },
      child,
      {
        ...child,
        id: 'branch-2',
        position: { x: 220, y: 220 },
      },
    ];
    let renderedNodes = initialNodes;
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      renderedNodes = typeof value === 'function' ? value(renderedNodes) : value;
    };
    const board = makeBoard({
      [zoneId]: {
        ...autoZone,
        height: 200,
        layout: { ...autoZone.layout, preset: 'grid' },
      },
    });
    const { result, unmount } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [placement, secondPlacement] as never,
          nodes: initialNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      const zoneNode = result.current.getBoardObjectNodes()[0];
      await (zoneNode.data.onArrangeContents as (id: string) => Promise<void>)(zoneId);
    });
    expect(result.current.zoneStackByNodeId.size).toBe(0);
    const packedPosition = renderedNodes.find((node) => node.id === 'branch-1')?.position;
    boardsPatch.mockClear();
    boardObjectsPatch.mockClear();

    await act(async () => {
      await result.current.setPlacementCompact(placement as never, false);
    });

    expect(result.current.calledOutNodeIds.has('branch-1')).toBe(false);
    expect(boardsPatch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'upsertObject',
        objectId: zoneId,
        objectData: expect.objectContaining({
          layout: expect.objectContaining({ mode: 'manual' }),
        }),
      })
    );
    expect(boardObjectsPatch).toHaveBeenCalledWith('placement-branch', { compact: false });
    expect(renderedNodes.find((node) => node.id === 'branch-1')?.position).toEqual(packedPosition);

    await act(async () => {
      await result.current.setPlacementCompact(placement as never, true);
    });

    expect(result.current.calledOutNodeIds.has('branch-1')).toBe(false);
    expect(renderedNodes.find((node) => node.id === 'branch-1')?.position).toEqual(packedPosition);
    expect(boardObjectsPatch).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('cancels a queued auto pass so a directly moved child stays at its dropped position', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const droppedChild = { ...child, position: { x: 333, y: 222 } };
    const setNodes = vi.fn();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({
            [zoneId]: { ...autoZone, layout: { ...autoZone.layout, preset: 'grid' } },
          }),
          client,
          boardObjectsForBoard: [placement] as never,
          nodes: [droppedChild],
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.demoteAutoZone(zoneId);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(boardsPatch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'upsertObject',
        objectId: zoneId,
        objectData: expect.objectContaining({
          layout: expect.objectContaining({ mode: 'manual' }),
        }),
      })
    );
    expect(boardObjectsPatch).not.toHaveBeenCalled();
    expect(setNodes).not.toHaveBeenCalled();
    expect(droppedChild.position).toEqual({ x: 333, y: 222 });
  });

  it('leaves an already-manual zone manual while applying the requested density', async () => {
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const manual = makeBoard({
      [zoneId]: { ...autoZone, layout: { ...autoZone.layout, mode: 'manual' } },
    });
    const { result } = renderInteraction(manual, client);

    await act(async () => {
      await result.current.setPlacementCompact(placement as never, false);
    });

    expect(boardsPatch).not.toHaveBeenCalled();
    expect(boardObjectsPatch).toHaveBeenCalledWith('placement-branch', { compact: false });
  });

  it('re-arming auto mode schedules a fresh tidy', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch } = makeRoutedClient();
    let board = makeBoard({
      [zoneId]: { ...autoZone, layout: { ...autoZone.layout, mode: 'auto', preset: 'grid' } },
    });
    const { result, rerender } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [placement] as never,
          nodes: [
            {
              ...child,
              width: 300,
              height: 100,
            },
          ],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(layoutPlacements(boardsPatch)['placement-branch']).toBeDefined();
    boardsPatch.mockClear();

    await act(async () => {
      await result.current.demoteAutoZone(zoneId);
    });
    board = makeBoard({
      [zoneId]: { ...autoZone, layout: { ...autoZone.layout, mode: 'manual', preset: 'grid' } },
    });
    rerender();
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    boardsPatch.mockClear();

    board = makeBoard({
      [zoneId]: { ...autoZone, layout: { ...autoZone.layout, mode: 'auto', preset: 'grid' } },
    });
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(layoutPlacements(boardsPatch)['placement-branch']).toEqual(
      expect.objectContaining({ position: { x: 20, y: 100 } })
    );
  });
});

/**
 * `setZoneContentsCompact` is the UI half of `agor_boards_set_compact` scoped
 * to a zone, so these cover the same targeting and idempotence contract the
 * MCP tool is tested against.
 */
describe('setZoneContentsCompact', () => {
  const placements = [
    {
      object_id: 'obj-branch',
      zone_id: 'zone-1',
      branch_id: 'branch-1',
      entity_type: 'branch',
    },
    { object_id: 'obj-card', zone_id: 'zone-1', card_id: 'card-1', entity_type: 'card' },
    {
      object_id: 'obj-header-only-card',
      zone_id: 'zone-1',
      card_id: 'header-only',
      entity_type: 'card',
    },
    {
      object_id: 'obj-other-zone',
      zone_id: 'zone-2',
      branch_id: 'branch-2',
      entity_type: 'branch',
    },
    // A nested zone placement carries neither branch_id nor card_id and is
    // not an entity the density control applies to.
    { object_id: 'obj-not-entity', zone_id: 'zone-1' },
  ];

  function renderCompact(client: unknown, boardObjectsForBoard: unknown[] = placements) {
    return renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({
            'zone-1': { type: 'zone', x: 0, y: 0, width: 400, height: 300, label: 'Z' },
          }),
          client: client as never,
          boardObjectsForBoard: boardObjectsForBoard as never,
          nodes: [
            {
              id: 'card-card-1',
              type: 'cardNode',
              position: { x: 0, y: 0 },
              data: { card: { card_id: 'card-1', description: 'Rendered body' } },
            },
            {
              id: 'card-header-only',
              type: 'cardNode',
              position: { x: 0, y: 0 },
              data: { card: { card_id: 'header-only', title: 'Header only' } },
            },
          ],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
  }

  it('patches worktrees and body cards while excluding header-only cards and other zones', async () => {
    const { client, patch } = makeClient();
    const { result } = renderCompact(client);

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', true);
    });

    expect(client.service).toHaveBeenCalledWith('board-objects');
    expect(patch.mock.calls.map((call) => call[0])).toEqual(['obj-branch', 'obj-card']);
    for (const call of patch.mock.calls) {
      expect(call[1]).toEqual({ compact: true });
    }
  });

  it('derives the zone toolbar capability from real card bodies, not card kind alone', () => {
    const { client } = makeClient();
    const { result } = renderCompact(client, [
      { ...placements[0], compact: true },
      { ...placements[1], compact: true },
      { ...placements[2], compact: true },
    ]);

    const zone = result.current.getBoardObjectNodes()[0];
    expect(zone.data).toMatchObject({
      positionableItemCount: 3,
      densityExpandableItemCount: 2,
      compactDensityExpandableItemCount: 2,
    });
  });

  it('expands a collapsed zone back to full density', async () => {
    const { client, patch } = makeClient();
    const { result } = renderCompact(
      client,
      placements.map((placement) => ({ ...placement, compact: true }))
    );

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', false);
    });

    expect(patch.mock.calls.map((call) => call[0])).toEqual(['obj-branch', 'obj-card']);
    expect(patch.mock.calls[0][1]).toEqual({ compact: false });
  });

  it('skips placements already at the requested density', async () => {
    const { client, patch } = makeClient();
    const { result } = renderCompact(client, [
      {
        object_id: 'obj-branch',
        zone_id: 'zone-1',
        branch_id: 'branch-1',
        entity_type: 'branch',
        compact: true,
      },
      {
        object_id: 'obj-card',
        zone_id: 'zone-1',
        card_id: 'card-1',
        entity_type: 'card',
        compact: true,
      },
    ]);

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', true);
    });

    expect(patch).not.toHaveBeenCalled();
  });

  it('is a no-op — no patch, no toast — when the zone is already uniform', async () => {
    const { client, patch } = makeClient();
    const { result } = renderCompact(
      client,
      placements.map((placement) => ({ ...placement, compact: true }))
    );

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', true);
    });

    expect(patch).not.toHaveBeenCalled();
    expect(showSuccess).not.toHaveBeenCalled();
  });

  it('surfaces a themed error when the patch fails', async () => {
    const { client } = makeRejectingClient();
    const { result } = renderCompact(client);

    await act(async () => {
      await result.current.setZoneContentsCompact('zone-1', true);
    });

    expect(showError).toHaveBeenCalledWith('Failed to update zone density');
    expect(showSuccess).not.toHaveBeenCalled();
  });
});

/** Geometry presentation never owns density; preset edits preserve every item. */
describe('handleUpdateObject density/preset orthogonality', () => {
  const zoneId = 'zone-1';
  const collapsed = [
    {
      object_id: 'obj-branch',
      zone_id: zoneId,
      branch_id: 'branch-1',
      entity_type: 'branch',
      compact: true,
    },
    {
      object_id: 'obj-card',
      zone_id: zoneId,
      card_id: 'card-1',
      entity_type: 'card',
      compact: true,
    },
  ];

  function zone(preset: string, mode: 'auto' | 'manual' = 'manual') {
    return {
      type: 'zone',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      label: 'Triage',
      layout: { mode, preset },
    };
  }

  function renderUpdate(boardPreset: string, boardObjectsForBoard: unknown[], client: unknown) {
    return renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone(boardPreset) }),
          client: client as never,
          boardObjectsForBoard: boardObjectsForBoard as never,
          nodes: [],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
  }

  /** Patch calls the expansion made, keyed by placement id. */
  function compactPatches(patch: ReturnType<typeof vi.fn>) {
    return patch.mock.calls
      .filter((call) => call[1] && typeof call[1] === 'object' && 'compact' in call[1])
      .map((call) => [call[0], call[1].compact]);
  }

  it('preserves collapsed contents when the preset leaves compact_list for grid', async () => {
    const { client, patch } = makeClient();
    const { result } = renderUpdate('compact_list', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(compactPatches(patch)).toEqual([]);
  });

  it('keeps auto mode armed without mutating density on a preset transition', async () => {
    const { client, patch } = makeClient();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('compact_list', 'auto') }),
          client,
          boardObjectsForBoard: collapsed as never,
          nodes: [],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid', 'auto') as never);
    });

    expect(compactPatches(patch)).toEqual([]);
    expect(
      patch.mock.calls.some(
        (call) => call[1]?._action === 'mergeObjectFields' && call[1].objects?.[zoneId]?.layout
      )
    ).toBe(false);
  });

  it('does not expand when a grid zone is merely updated again', async () => {
    // The regression guard for automatic zones: a grid zone reflows and is
    // re-saved constantly, and each of those must leave hand-collapsed worktrees
    // alone.
    const { client, patch } = makeClient();
    const { result } = renderUpdate('grid', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(compactPatches(patch)).toEqual([]);
  });

  it('does not expand when the zone stays on compact_list', async () => {
    const { client, patch } = makeClient();
    const { result } = renderUpdate('compact_list', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, {
        ...zone('compact_list'),
        label: 'Renamed',
      } as never);
    });

    expect(compactPatches(patch)).toEqual([]);
  });

  it('expands silently — the arrange that follows reports its own result', async () => {
    const { client } = makeClient();
    const { result } = renderUpdate('compact_list', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(showSuccess).not.toHaveBeenCalled();
  });

  it('leaves other zones alone when one zone exits compact_list', async () => {
    const { client, patch } = makeClient();
    const { result } = renderUpdate(
      'compact_list',
      [
        ...collapsed,
        {
          object_id: 'obj-elsewhere',
          zone_id: 'zone-2',
          branch_id: 'branch-9',
          entity_type: 'branch',
        },
      ],
      client
    );

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(compactPatches(patch).map(([id]) => id)).not.toContain('obj-elsewhere');
  });

  it('does not expand when the board patch itself fails', async () => {
    const { client, patch } = makeRejectingClient();
    const { result } = renderUpdate('compact_list', collapsed, client);

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    expect(compactPatches(patch)).toEqual([]);
  });
});

describe('explicit density changes own any required re-pack', () => {
  const zoneId = 'zone-1';

  function zone(preset: string) {
    return {
      type: 'zone',
      x: 0,
      y: 0,
      width: 420,
      height: 900,
      label: 'Triage',
      layout: { mode: 'manual', preset },
    };
  }

  const placements = [
    {
      object_id: 'obj-a',
      zone_id: zoneId,
      branch_id: 'branch-a',
      entity_type: 'branch',
      compact: true,
    },
    {
      object_id: 'obj-b',
      zone_id: zoneId,
      branch_id: 'branch-b',
      entity_type: 'branch',
      compact: true,
    },
  ];

  // Stacked at compact_list's row pitch, which overlaps once each worktree
  // restores its full measured height.
  const nodes = [
    {
      id: 'branch-a',
      type: 'branchNode',
      parentId: zoneId,
      position: { x: 24, y: 64 },
      width: 500,
      height: 180,
      data: {},
    },
    {
      id: 'branch-b',
      type: 'branchNode',
      parentId: zoneId,
      position: { x: 24, y: 120 },
      width: 500,
      height: 180,
      data: {},
    },
  ];

  it('does not expand or re-pack merely because List changes to Grid', async () => {
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const setNodes = vi.fn();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('compact_list') }),
          client: client as never,
          boardObjectsForBoard: placements as never,
          nodes: nodes as never,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });

    const compactPatches = patch.mock.calls.filter((c) => c[1] && 'compact' in c[1]);
    expect(compactPatches.map((c) => c[1].compact)).toEqual([]);
    expect(patch.mock.calls.some((c) => c[1] && 'position' in c[1])).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(Object.values(layoutPlacements(patch))).toEqual([]);
  });

  it('re-packs when the zone toolbar expands the contents directly', async () => {
    // The toolbar calls setZoneContentsCompact, which never passes through
    // handleUpdateObject, so the preset-change re-pack does not cover it. Left
    // unrepaired the button reliably produces the overlap the preset path
    // avoids -- and the compact flags all flip correctly while it does.
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('grid') }),
          client: client as never,
          boardObjectsForBoard: placements as never,
          nodes: nodes as never,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.setZoneContentsCompact(zoneId, false);
    });

    expect(patch.mock.calls.some((c) => c[1] && 'position' in c[1])).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const positioned = Object.values(layoutPlacements(patch)) as Array<{
      position: { x: number; y: number };
    }>;
    expect(positioned.length).toBeGreaterThan(0);
    const ys = positioned.map((value) => value.position.y).sort((a, b) => a - b);
    if (ys.length === 2) expect(ys[1] - ys[0]).toBeGreaterThan(56);
  });

  it('does not re-pack when the toolbar collapses the contents', async () => {
    // Collapsing shrinks every item, which cannot create an overlap; a re-pack
    // there would move worktrees the user did not ask to move.
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('grid') }),
          client: client as never,
          boardObjectsForBoard: [
            {
              object_id: 'obj-a',
              zone_id: zoneId,
              branch_id: 'branch-a',
              entity_type: 'branch',
              compact: false,
            },
            {
              object_id: 'obj-b',
              zone_id: zoneId,
              branch_id: 'branch-b',
              entity_type: 'branch',
              compact: false,
            },
          ] as never,
          nodes: nodes as never,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.setZoneContentsCompact(zoneId, true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(patch.mock.calls.some((c) => c[1] && 'position' in c[1])).toBe(false);
  });

  it('does not schedule a re-pack when the preset did not leave compact_list', async () => {
    vi.useFakeTimers();
    const { client, patch } = makeClient();
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({ [zoneId]: zone('grid') }),
          client: client as never,
          boardObjectsForBoard: placements as never,
          nodes: nodes as never,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleUpdateObject(zoneId, zone('grid') as never);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(patch.mock.calls.some((c) => c[1] && 'position' in c[1])).toBe(false);
  });
});

describe('arrangeBoardZones production path', () => {
  it('preserves mixed density by default and applies only explicit collapse or expand atomically', async () => {
    const board = makeBoard({
      zone: {
        type: 'zone',
        x: 900,
        y: 500,
        width: 900,
        height: 700,
        label: 'Fictional review',
        layout: { mode: 'manual', preset: 'compact_list' },
      },
    });
    const nodes: Node[] = [
      { id: 'zone', type: 'zone', position: { x: 900, y: 500 }, width: 900, height: 700, data: {} },
      {
        id: 'expanded',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 100 },
        width: 500,
        height: 200,
        data: { compact: false },
      },
      {
        id: 'collapsed',
        type: 'branchNode',
        parentId: 'zone',
        position: { x: 20, y: 324 },
        width: 500,
        height: 100,
        data: { compact: true },
      },
      {
        id: 'card-body',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 20, y: 448 },
        width: 380,
        height: 140,
        data: { card: { title: 'Sample', description: 'Fictional body' } },
      },
      {
        id: 'card-header',
        type: 'cardNode',
        parentId: 'zone',
        position: { x: 420, y: 448 },
        width: 380,
        height: 60,
        data: { card: { title: 'Header only' } },
      },
    ];
    const placements = [
      {
        object_id: 'p-expanded',
        board_id: 'board-1',
        entity_type: 'branch',
        branch_id: 'expanded',
        zone_id: 'zone',
        position: { x: 20, y: 100 },
        size: { width: 500, height: 200 },
        compact: false,
      },
      {
        object_id: 'p-collapsed',
        board_id: 'board-1',
        entity_type: 'branch',
        branch_id: 'collapsed',
        zone_id: 'zone',
        position: { x: 20, y: 324 },
        size: { width: 500, height: 100 },
        compact: true,
      },
      {
        object_id: 'p-body',
        board_id: 'board-1',
        entity_type: 'card',
        card_id: 'body',
        zone_id: 'zone',
        position: { x: 20, y: 448 },
        size: { width: 380, height: 140 },
      },
      {
        object_id: 'p-header',
        board_id: 'board-1',
        entity_type: 'card',
        card_id: 'header',
        zone_id: 'zone',
        position: { x: 420, y: 448 },
        size: { width: 380, height: 60 },
      },
    ] as never;

    const run = async (density: 'preserve' | 'expand' | 'collapse') => {
      const routed = makeRoutedClient();
      const view = renderHook(
        () =>
          useBoardObjects({
            board,
            client: routed.client,
            boardObjectsForBoard: placements,
            nodes,
            setNodes: vi.fn(),
            deletedObjectsRef: { current: new Set<string>() },
          }),
        { wrapper }
      );
      await act(async () => view.result.current.arrangeWholeBoard({ density }));
      return routed.boardsPatch.mock.calls[0]?.[1].placements as Record<
        string,
        { compact?: boolean }
      >;
    };

    const preserved = await run('preserve');
    expect(Object.values(preserved).every((placement) => placement.compact === undefined)).toBe(
      true
    );
    const collapsed = await run('collapse');
    expect(collapsed['p-expanded']?.compact).toBe(true);
    expect(collapsed['p-body']?.compact).toBe(true);
    expect(collapsed['p-collapsed']?.compact).toBeUndefined();
    expect(collapsed['p-header']?.compact).toBeUndefined();
    const expanded = await run('expand');
    expect(expanded['p-collapsed']?.compact).toBe(false);
    expect(expanded['p-expanded']?.compact).toBeUndefined();
    expect(expanded['p-header']?.compact).toBeUndefined();
  });

  it('packs an anchored protruding canvas child inside-out before placing its final zone frame', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const board = makeBoard({
      tiny: { type: 'zone', x: 80, y: 80, width: 300, height: 220, label: 'Tiny' },
      artifact: {
        type: 'artifact',
        x: 100,
        y: 120,
        width: 860,
        height: 660,
        artifact_id: 'artifact-1',
      },
    });
    const nodes: Node[] = [
      {
        id: 'tiny',
        type: 'zone',
        position: { x: 80, y: 80 },
        width: 300,
        height: 220,
        data: {},
      },
      {
        id: 'artifact',
        type: 'artifactNode',
        position: { x: 100, y: 120 },
        width: 860,
        height: 660,
        data: {},
      },
    ];
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => result.current.arrangeWholeBoard(true));

    const write = boardsPatch.mock.calls[0]?.[1] as {
      _action: string;
      objects: NonNullable<Board['objects']>;
    };
    const zone = write.objects.tiny;
    const artifact = write.objects.artifact;
    expect(write._action).toBe('applyLayout');
    expect(zone).toMatchObject({ type: 'zone' });
    expect(artifact).toMatchObject({ type: 'artifact' });
    if (zone?.type !== 'zone' || artifact?.type !== 'artifact') throw new Error('bad fixture');
    expect(zone.width).toBeGreaterThanOrEqual(900);
    expect(artifact.x).toBeGreaterThanOrEqual(zone.x);
    expect(artifact.y).toBeGreaterThanOrEqual(zone.y);
    expect(artifact.x + artifact.width).toBeLessThanOrEqual(zone.x + zone.width);
    expect(artifact.y + artifact.height).toBeLessThanOrEqual(zone.y + zone.height);
  });

  it('preserves inner frames with Pack off and excludes a zone containing a locked child', async () => {
    const unlockedClient = makeRoutedClient();
    const unlockedBoard = makeBoard({
      manual: { type: 'zone', x: 900, y: 700, width: 300, height: 220, label: 'Manual' },
      artifact: {
        type: 'artifact',
        x: 920,
        y: 740,
        width: 860,
        height: 660,
        artifact_id: 'artifact-1',
      },
    });
    const unlockedNodes: Node[] = [
      {
        id: 'manual',
        type: 'zone',
        position: { x: 900, y: 700 },
        width: 300,
        height: 220,
        data: {},
      },
      {
        id: 'artifact',
        type: 'artifactNode',
        position: { x: 920, y: 740 },
        width: 860,
        height: 660,
        data: {},
      },
    ];
    const unlocked = renderHook(
      () =>
        useBoardObjects({
          board: unlockedBoard,
          client: unlockedClient.client,
          boardObjectsForBoard: [],
          nodes: unlockedNodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    await act(async () => unlocked.result.current.arrangeWholeBoard(false));
    const offObjects = unlockedClient.boardsPatch.mock.calls[0]?.[1]?.objects as NonNullable<
      Board['objects']
    >;
    expect(offObjects.manual).toMatchObject({ width: 300, height: 220 });
    expect(offObjects.artifact).toMatchObject({ x: 100, y: 120, width: 860, height: 660 });

    unlocked.unmount();
    const lockedClient = makeRoutedClient();
    const lockedNodes = unlockedNodes.map((node) =>
      node.id === 'artifact' ? { ...node, data: { locked: true } } : node
    );
    const locked = renderHook(
      () =>
        useBoardObjects({
          board: unlockedBoard,
          client: lockedClient.client,
          boardObjectsForBoard: [],
          nodes: lockedNodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    await act(async () => locked.result.current.arrangeWholeBoard(true));
    expect(lockedClient.boardsPatch).not.toHaveBeenCalled();
  });

  it('emits one explicit full-board fit intent for material and unchanged Arrange writes', async () => {
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const onUserLayoutComplete = vi.fn();
    let board = makeBoard({
      one: { type: 'zone', x: 0, y: 0, width: 620, height: 500, label: 'One' },
      two: { type: 'zone', x: 2200, y: 0, width: 620, height: 500, label: 'Two' },
      three: { type: 'zone', x: 0, y: 1600, width: 620, height: 500, label: 'Three' },
    });
    let nodes: Node[] = Object.entries(board.objects ?? {}).map(([id, object]) => ({
      id,
      type: 'zone',
      position: { x: object.x, y: object.y },
      width: object.type === 'zone' ? object.width : 620,
      height: object.type === 'zone' ? object.height : 500,
      data: {},
    }));
    const setNodes: React.Dispatch<React.SetStateAction<Node[]>> = (value) => {
      nodes = typeof value === 'function' ? value(nodes) : value;
    };
    const { result, rerender } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
          onUserLayoutComplete,
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.arrangeWholeBoard({ viewportMode: 'fit' });
    });

    expect(boardsPatch).toHaveBeenCalledTimes(1);
    const firstWrite = boardsPatch.mock.calls[0]?.[1] as {
      objects: NonNullable<Board['objects']>;
    };
    expect(nodes.map(({ position }) => position)).toEqual(
      Object.values(firstWrite.objects).map((object) => ({ x: object.x, y: object.y }))
    );
    expect(onUserLayoutComplete).toHaveBeenCalledTimes(1);
    expect(onUserLayoutComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'user',
        boardId: 'board-1',
        scope: 'board',
        mode: 'fit',
      })
    );

    board = { ...board, objects: { ...board.objects, ...firstWrite.objects } };
    rerender();
    boardsPatch.mockClear();
    boardObjectsPatch.mockClear();
    showSuccess.mockClear();

    await act(async () => {
      await result.current.arrangeWholeBoard({ viewportMode: 'fit' });
    });

    expect(boardsPatch).not.toHaveBeenCalled();
    expect(boardObjectsPatch).not.toHaveBeenCalled();
    expect(onUserLayoutComplete).toHaveBeenCalledTimes(2);
    expect(onUserLayoutComplete.mock.calls[1]?.[0]).toMatchObject({
      mode: 'fit',
      before: expect.any(Array),
      after: expect.any(Array),
    });
    expect(onUserLayoutComplete.mock.calls[1]?.[0].before).toEqual(
      onUserLayoutComplete.mock.calls[1]?.[0].after
    );
    expect(showSuccess).toHaveBeenCalledWith('Zones and their contents are already arranged.');
  });

  it('routes unchecked whole-board Arrange through preserve intents without changing writes', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const onUserLayoutComplete = vi.fn();
    const onUserLayoutStart = vi.fn(() => 17);
    const board = makeBoard({
      moving: { type: 'zone', x: 1600, y: 900, width: 620, height: 500, label: 'Moving' },
      fixed: { type: 'zone', x: -900, y: -600, width: 480, height: 340, label: 'Fixed' },
    });
    const nodes: Node[] = [
      {
        id: 'moving',
        type: 'zone',
        position: { x: 1600, y: 900 },
        width: 620,
        height: 500,
        data: {},
      },
      {
        id: 'fixed',
        type: 'zone',
        position: { x: -900, y: -600 },
        width: 480,
        height: 340,
        data: { locked: true },
      },
    ];
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
          onUserLayoutStart,
          onUserLayoutComplete,
        }),
      { wrapper }
    );

    await act(async () => result.current.arrangeWholeBoard({ viewportMode: 'preserve' }));

    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(onUserLayoutStart).toHaveBeenCalledTimes(1);
    expect(onUserLayoutComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'preserve',
        scope: 'board',
        before: expect.arrayContaining([
          expect.objectContaining({ id: 'moving' }),
          expect.objectContaining({ id: 'fixed' }),
        ]),
        after: expect.arrayContaining([
          expect.objectContaining({ id: 'moving' }),
          expect.objectContaining({ id: 'fixed' }),
        ]),
      }),
      17
    );
  });

  it('centers selection-only zone layout and routes around every unselected fixed peer', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const onUserLayoutComplete = vi.fn();
    const board = makeBoard({
      one: { type: 'zone', x: 900, y: 700, width: 420, height: 300, label: 'One' },
      two: { type: 'zone', x: 1500, y: 900, width: 520, height: 340, label: 'Two' },
      other: { type: 'zone', x: 2400, y: 200, width: 620, height: 500, label: 'Other' },
      note: { type: 'markdown', x: -500, y: 1600, width: 320, content: 'Unselected note' },
    });
    const nodes: Node[] = [
      { id: 'one', type: 'zone', position: { x: 900, y: 700 }, width: 420, height: 300, data: {} },
      { id: 'two', type: 'zone', position: { x: 1500, y: 900 }, width: 520, height: 340, data: {} },
      {
        id: 'other',
        type: 'zone',
        position: { x: 2400, y: 200 },
        width: 620,
        height: 500,
        data: {},
      },
      {
        id: 'note',
        type: 'markdown',
        position: { x: -500, y: 1600 },
        width: 320,
        height: 180,
        data: { objectId: 'note' },
      },
      {
        id: 'other-child',
        type: 'cardNode',
        parentId: 'other',
        position: { x: -820, y: 500 },
        width: 320,
        height: 180,
        data: { card: { title: 'Unselected protruding child' } },
      },
      {
        id: 'free-branch',
        type: 'branchNode',
        position: { x: 400, y: -600 },
        width: 500,
        height: 200,
        data: { branch: { name: 'Unselected branch' } },
      },
    ];
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'free-placement',
              branch_id: 'free-branch',
              position: { x: 400, y: -600 },
            },
          ] as never,
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
          onUserLayoutComplete,
        }),
      { wrapper }
    );

    await act(async () =>
      result.current.arrangeBoardZones(['one', 'two'], {
        fixedItemsPerRow: 2,
        layoutScope: 'selection',
        userInitiated: true,
      })
    );

    const write = boardsPatch.mock.calls[0]?.[1];
    expect(Object.keys(write.objects).sort()).toEqual(['one', 'two']);
    expect(write.placements).toEqual({});
    expect(write.objects.one).toMatchObject({ x: 660, y: 920 });
    expect(write.objects.two).toMatchObject({ x: 1480, y: 920 });
    expect(write.objects.other).toBeUndefined();
    expect(write.objects.note).toBeUndefined();
    expect(onUserLayoutComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'selection',
        mode: 'smart',
        before: [expect.objectContaining({ id: 'one' }), expect.objectContaining({ id: 'two' })],
        after: [expect.objectContaining({ id: 'one' }), expect.objectContaining({ id: 'two' })],
      })
    );
  });

  it('routes Arrange board through byte-equivalent selected-all planner writes', async () => {
    const board = makeBoard({
      one: { type: 'zone', x: 1200, y: 600, width: 620, height: 500, label: 'One' },
      note: { type: 'markdown', x: -400, y: 900, width: 320, content: 'Free note' },
    });
    const nodes: Node[] = [
      {
        id: 'one',
        type: 'zone',
        position: { x: 1200, y: 600 },
        width: 620,
        height: 500,
        data: {},
      },
      {
        id: 'note',
        type: 'markdown',
        position: { x: -400, y: 900 },
        width: 320,
        height: 180,
        data: { objectId: 'note', width: 320 },
      },
    ];
    const direct = makeRoutedClient();
    const toolbar = makeRoutedClient();
    const directView = renderHook(
      () =>
        useBoardObjects({
          board,
          client: direct.client,
          boardObjectsForBoard: [],
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    const toolbarView = renderHook(
      () =>
        useBoardObjects({
          board,
          client: toolbar.client,
          boardObjectsForBoard: [],
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => {
      await directView.result.current.arrangeBoardZones(['one'], { userInitiated: true });
      await toolbarView.result.current.arrangeWholeBoard();
    });

    expect(toolbar.boardsPatch.mock.calls).toEqual(direct.boardsPatch.mock.calls);
    expect(toolbar.boardObjectsPatch.mock.calls).toEqual(direct.boardObjectsPatch.mock.calls);
  });

  it('arranges free mixed objects without requiring a zone', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const onUserLayoutComplete = vi.fn();
    const board = makeBoard({
      note: { type: 'markdown', x: 1600, y: 900, width: 320, content: 'Note' },
      app: {
        type: 'app',
        x: -800,
        y: 600,
        width: 360,
        height: 220,
        title: 'App',
        template: 'react',
        files: {},
      },
    });
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes: [
            {
              id: 'note',
              type: 'markdown',
              position: { x: 1600, y: 900 },
              width: 320,
              height: 180,
              data: { objectId: 'note' },
            },
            {
              id: 'app',
              type: 'appNode',
              position: { x: -800, y: 600 },
              width: 360,
              height: 220,
              data: { objectId: 'app' },
            },
          ],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
          onUserLayoutComplete,
        }),
      { wrapper }
    );

    expect(result.current.canArrangeWholeBoard).toBe(true);
    await act(async () => result.current.arrangeWholeBoard());

    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(Object.keys(boardsPatch.mock.calls[0]?.[1].objects).sort()).toEqual(['app', 'note']);
    expect(onUserLayoutComplete).toHaveBeenCalledTimes(1);
  });

  it('preserves locked zones, locked objects, and their geometric membership', async () => {
    const { client, boardsPatch } = makeRoutedClient();
    const board = makeBoard({
      open: { type: 'zone', x: 1400, y: 0, width: 620, height: 500, label: 'Open' },
      locked: { type: 'zone', x: 0, y: 0, width: 620, height: 500, label: 'Locked', locked: true },
      blocked: { type: 'zone', x: 0, y: 800, width: 620, height: 500, label: 'Blocked' },
      member: {
        type: 'artifact',
        artifact_id: 'member-artifact',
        x: 100,
        y: 140,
        width: 260,
        height: 180,
      },
      protected: {
        type: 'artifact',
        artifact_id: 'protected-artifact',
        x: 100,
        y: 940,
        width: 260,
        height: 180,
        locked: true,
      },
      free: { type: 'markdown', x: 2200, y: 900, width: 320, content: 'Free' },
    });
    const nodes: Node[] = [
      { id: 'open', type: 'zone', position: { x: 1400, y: 0 }, width: 620, height: 500, data: {} },
      {
        id: 'locked',
        type: 'zone',
        position: { x: 0, y: 0 },
        width: 620,
        height: 500,
        data: { locked: true },
      },
      {
        id: 'blocked',
        type: 'zone',
        position: { x: 0, y: 800 },
        width: 620,
        height: 500,
        data: {},
      },
      {
        id: 'member',
        type: 'artifactNode',
        position: { x: 100, y: 140 },
        width: 260,
        height: 180,
        data: { objectId: 'member' },
      },
      {
        id: 'protected',
        type: 'artifactNode',
        position: { x: 100, y: 940 },
        width: 260,
        height: 180,
        data: { objectId: 'protected', locked: true },
      },
      {
        id: 'free',
        type: 'markdown',
        position: { x: 2200, y: 900 },
        width: 320,
        height: 180,
        data: { objectId: 'free' },
      },
    ];
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    await act(async () => result.current.arrangeWholeBoard());

    const objects = boardsPatch.mock.calls[0]?.[1].objects;
    expect(Object.keys(objects).sort()).toEqual(['free', 'open']);
    expect(objects.locked).toBeUndefined();
    expect(objects.blocked).toBeUndefined();
    expect(objects.member).toBeUndefined();
    expect(objects.protected).toBeUndefined();
    expect(Object.keys(boardsPatch.mock.calls[0]?.[1].expected.objects).sort()).toEqual([
      'blocked',
      'free',
      'locked',
      'member',
      'open',
      'protected',
    ]);
  });

  it('rejects a concurrent Arrange board click until the batch settles', async () => {
    let releaseWrite: (() => void) | undefined;
    const { client, boardsPatch } = makeRoutedClient();
    boardsPatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWrite = () => resolve({});
        })
    );
    const board = makeBoard({
      zone: { type: 'zone', x: 1600, y: 900, width: 620, height: 500, label: 'Zone' },
    });
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client,
          boardObjectsForBoard: [],
          nodes: [
            {
              id: 'zone',
              type: 'zone',
              position: { x: 1600, y: 900 },
              width: 620,
              height: 500,
              data: {},
            },
          ],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = result.current.arrangeWholeBoard();
      second = result.current.arrangeWholeBoard();
    });
    expect(result.current.isBoardArrangementActive).toBe(true);
    expect(boardsPatch).toHaveBeenCalledTimes(1);

    releaseWrite?.();
    await act(async () => Promise.all([first, second]));
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(result.current.isBoardArrangementActive).toBe(false);
  });

  it('writes one zone batch, re-packs measured children, and cancels pending Auto Zone passes', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const board = makeBoard({
      'zone-b': {
        type: 'zone',
        x: 800,
        y: 0,
        width: 620,
        height: 600,
        label: 'B',
        layout: { mode: 'auto' },
      },
      'zone-a': {
        type: 'zone',
        x: 0,
        y: 0,
        width: 620,
        height: 600,
        label: 'A',
        layout: { mode: 'auto' },
      },
      artifact: {
        type: 'artifact',
        artifact_id: 'artifact-1',
        x: 0,
        y: 800,
        width: 720,
        height: 420,
      },
    });
    const nodes: Node[] = [
      { id: 'zone-b', type: 'zone', position: { x: 800, y: 0 }, width: 620, height: 600, data: {} },
      { id: 'zone-a', type: 'zone', position: { x: 0, y: 0 }, width: 620, height: 600, data: {} },
      {
        id: 'branch-a',
        type: 'branchNode',
        parentId: 'zone-a',
        position: { x: 200, y: 240 },
        width: 500,
        height: 200,
        data: { branch: { name: 'Branch A' } },
      },
      {
        id: 'card-b',
        type: 'cardNode',
        parentId: 'zone-b',
        position: { x: 180, y: 220 },
        width: 380,
        height: 100,
        data: { card: { title: 'Card B', data: {} } },
      },
      {
        id: 'free-branch',
        type: 'branchNode',
        position: { x: 800, y: 800 },
        width: 500,
        height: 200,
        data: { branch: { name: 'Free branch' } },
      },
      {
        id: 'artifact',
        type: 'artifactNode',
        position: { x: 0, y: 800 },
        width: 720,
        height: 420,
        data: { objectId: 'artifact', width: 720, height: 420 },
      },
    ];
    const onArrangeNodes = vi.fn();
    const onUserLayoutComplete = vi.fn();
    const view = renderHook(
      (props: { board: Board; nodes: Node[] }) =>
        useBoardObjects({
          board: props.board,
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-a',
              branch_id: 'branch-a',
              zone_id: 'zone-a',
              position: { x: 200, y: 240 },
            },
            {
              object_id: 'placement-b',
              card_id: 'b',
              zone_id: 'zone-b',
              position: { x: 180, y: 220 },
            },
            {
              object_id: 'placement-free',
              branch_id: 'free-branch',
              position: { x: 800, y: 800 },
            },
          ] as never,
          nodes: props.nodes,
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
          onArrangeNodes,
          onUserLayoutComplete,
        }),
      { wrapper, initialProps: { board, nodes } }
    );

    await act(async () => {
      await view.result.current.arrangeBoardZones(['zone-b', 'zone-a']);
    });
    const write = boardsPatch.mock.calls[0]?.[1];
    const arrangedNodes = onArrangeNodes.mock.calls[0]?.[0] as Node[];
    const arrangedById = new Map(arrangedNodes.map((node) => [node.id, node]));
    view.rerender({
      board: { ...board, objects: { ...board.objects, ...write.objects } } as Board,
      nodes: nodes.map((node) => arrangedById.get(node.id) ?? node),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(boardsPatch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'applyLayout',
        objects: {
          'zone-a': expect.objectContaining({ type: 'zone' }),
          'zone-b': expect.objectContaining({ type: 'zone' }),
          artifact: expect.objectContaining({ type: 'artifact' }),
        },
        placements: expect.objectContaining({
          'placement-a': expect.objectContaining({ position: expect.any(Object) }),
          'placement-b': expect.objectContaining({ position: expect.any(Object) }),
          'placement-free': expect.objectContaining({ position: expect.any(Object) }),
        }),
      })
    );
    expect(boardObjectsPatch).not.toHaveBeenCalled();
    expect(onArrangeNodes).toHaveBeenCalledTimes(1);
    expect(onUserLayoutComplete).not.toHaveBeenCalled();
    expect(showSuccess).toHaveBeenCalledTimes(1);
    expect(showWarning).not.toHaveBeenCalled();
  });

  it('lets explicit Pack shrink a preserved Auto Zone frame to a new content-safe floor', async () => {
    vi.useFakeTimers();
    const { client, boardsPatch, boardObjectsPatch } = makeRoutedClient();
    const zoneId = 'zone-auto';
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board: makeBoard({
            [zoneId]: {
              type: 'zone',
              x: 0,
              y: 0,
              width: 800,
              height: 1000,
              label: 'Automatic',
              layout: { mode: 'auto', resize: 'height' },
            },
          }),
          client,
          boardObjectsForBoard: [
            {
              object_id: 'placement-a',
              branch_id: 'branch-a',
              zone_id: zoneId,
              position: { x: 200, y: 240 },
              size: { width: 500, height: 200 },
            },
          ] as never,
          nodes: [
            {
              id: 'branch-a',
              type: 'branchNode',
              parentId: zoneId,
              position: { x: 200, y: 240 },
              width: 500,
              height: 200,
              data: { branch: { name: 'Branch A' } },
            },
          ],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    act(() => result.current.preserveAutoZoneFrameOnce(zoneId));
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(boardsPatch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(boardsPatch).toHaveBeenCalledTimes(1);
    expect(layoutPlacements(boardsPatch)['placement-a']).toEqual({
      position: { x: 20, y: 100 },
      size: { width: 500, height: 200 },
    });
    expect(boardObjectsPatch).not.toHaveBeenCalled();

    boardsPatch.mockClear();
    const zoneNode = result.current.getBoardObjectNodes().find((node) => node.id === zoneId);
    expect(zoneNode).toBeDefined();
    await act(async () => {
      await (zoneNode!.data.onArrangeContents as (id: string) => Promise<void>)(zoneId);
    });
    expect(layoutWrites(boardsPatch)).toHaveLength(1);
    expect(layoutWrites(boardsPatch)[0]?.objects).toEqual({
      'zone-auto': expect.objectContaining({ width: 540, height: 320 }),
    });
  });
});

describe('whole-board stale layout recovery', () => {
  const staleBoard = makeBoard({
    zone: { type: 'zone', x: 1600, y: 900, width: 620, height: 500, label: 'Planning' },
  });
  const freshBoard = makeBoard({
    zone: { type: 'zone', x: 1760, y: 980, width: 620, height: 500, label: 'Planning' },
  });
  const staleNodes: Node[] = [
    {
      id: 'zone',
      type: 'zone',
      position: { x: 1600, y: 900 },
      width: 620,
      height: 500,
      data: {},
    },
  ];

  function renderWholeBoardRecovery(firstWrite: Promise<unknown>) {
    let attempts = 0;
    const boardsPatch = vi.fn().mockImplementation((boardId, data) => {
      attempts += 1;
      if (attempts === 1) return firstWrite;
      return mockBoardPatchResult(boardId, data);
    });
    const boardsGet = vi.fn().mockResolvedValue(freshBoard);
    const placementsFindAll = vi.fn().mockResolvedValue([]);
    const service = vi.fn((path: string) =>
      path === 'boards'
        ? { patch: boardsPatch, get: boardsGet }
        : { patch: vi.fn(), findAll: placementsFindAll }
    );
    const setNodes = vi.fn();
    const view = renderHook(
      () =>
        useBoardObjects({
          board: staleBoard,
          client: { service } as never,
          boardObjectsForBoard: [],
          nodes: staleNodes,
          setNodes,
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );
    return { ...view, boardsPatch, boardsGet, placementsFindAll, setNodes };
  }

  it('replans Arrange Board once from a fresh complete source snapshot', async () => {
    const view = renderWholeBoardRecovery(
      Promise.reject(new Error('Board layout source snapshot is stale'))
    );

    await act(async () => view.result.current.arrangeWholeBoard());

    expect(layoutWrites(view.boardsPatch)).toHaveLength(2);
    expect(layoutWrites(view.boardsPatch)[1]?.expected.objects).toEqual({
      zone: { x: 1760, y: 980, width: 620, height: 500 },
    });
    expect(view.boardsGet).toHaveBeenCalledTimes(1);
    expect(view.placementsFindAll).toHaveBeenCalledTimes(1);
    expect(view.setNodes).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('cancels a stale replan when a newer drag/resize intent takes ownership', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const firstWrite = new Promise((_, reject) => {
      rejectFirst = reject;
    });
    const view = renderWholeBoardRecovery(firstWrite);

    let arrange: Promise<void> | undefined;
    act(() => {
      arrange = view.result.current.arrangeWholeBoard();
    });
    act(() => view.result.current.cancelPendingLayoutRecovery());
    rejectFirst?.(new Error('Board layout source snapshot is stale'));
    await act(async () => arrange);

    expect(layoutWrites(view.boardsPatch)).toHaveLength(1);
    expect(view.boardsGet).not.toHaveBeenCalled();
    expect(view.setNodes).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});

describe('board object finite-geometry node boundary', () => {
  it('does not mis-render legacy text or non-finite objects as zones', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const board = makeBoard({
      'legacy-text': { type: 'text', x: 20, y: 40, content: 'Fictional label' },
      invalid: {
        type: 'zone',
        x: Number.POSITIVE_INFINITY,
        y: 0,
        width: 400,
        height: 300,
        label: 'Invalid',
      },
      'missing-size': {
        type: 'zone',
        x: 100,
        y: 100,
        label: 'Invalid runtime payload',
      } as never,
      valid: { type: 'zone', x: 0, y: 0, width: 400, height: 300, label: 'Valid' },
    });
    const { result } = renderHook(
      () =>
        useBoardObjects({
          board,
          client: makeClient().client,
          boardObjectsForBoard: [],
          nodes: [],
          setNodes: vi.fn(),
          deletedObjectsRef: { current: new Set<string>() },
        }),
      { wrapper }
    );

    expect(result.current.getBoardObjectNodes().map((node) => node.id)).toEqual(['valid']);
    expect(consoleWarn).toHaveBeenCalledWith('Skipping board object with invalid geometry:', {
      objectId: 'invalid',
      type: 'zone',
    });
    expect(consoleWarn).toHaveBeenCalledWith('Skipping board object with invalid geometry:', {
      objectId: 'missing-size',
      type: 'zone',
    });
    expect(consoleWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: 'Fictional label',
      })
    );
    consoleWarn.mockRestore();
  });
});
