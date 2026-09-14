import type { Board, BoardObject } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { useBoardObjects } from './useBoardObjects';

// Spy the themed error toast so the failure path of reorderObject is observable.
const { showError } = vi.hoisted(() => ({ showError: vi.fn() }));
vi.mock('../../../utils/message', () => ({
  useThemedMessage: () => ({
    showError,
    showSuccess: vi.fn(),
    showWarning: vi.fn(),
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
  connectionState.connected = true;
  connectionState.connecting = false;
  connectionState.outOfSync = false;
});

/**
 * Minimal client whose `service('boards').patch` is a spy. reorderObject is the
 * only behavior exercised here, and it only touches `client` + `board`.
 */
function makeClient() {
  const patch = vi.fn().mockResolvedValue({});
  const service = vi.fn().mockReturnValue({ patch });
  const client = { service };
  return { client: client as never, patch, service };
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
