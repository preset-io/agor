import type { Board, BoardEntityObject } from '@agor-live/client';
import type { Node } from 'reactflow';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchAuthoritativeLayoutSource,
  isBoardLayoutSnapshotStale,
  rebaseNodesOnAuthoritativeLayout,
} from './layoutConflictRecovery';

const board = {
  board_id: 'board-1',
  objects: {
    zone: { type: 'zone', x: 40, y: 60, width: 640, height: 520, label: 'Review' },
    note: { type: 'markdown', x: 80, y: 140, width: 320, content: 'Fictional note' },
  },
} as unknown as Board;

const placement = {
  object_id: 'placement-1',
  board_id: 'board-1',
  branch_id: 'branch-1',
  entity_type: 'branch',
  zone_id: 'zone',
  position: { x: 20, y: 100 },
  size: { width: 500, height: 220 },
  compact: true,
  created_at: '2026-01-01T00:00:00.000Z',
} as BoardEntityObject;

const nodes: Node[] = [
  { id: 'zone', type: 'zone', position: { x: 0, y: 0 }, width: 400, height: 400, data: {} },
  { id: 'note', type: 'markdown', position: { x: 0, y: 0 }, width: 280, data: {} },
  {
    id: 'branch-1',
    type: 'branchNode',
    position: { x: 300, y: 300 },
    width: 500,
    height: 300,
    data: { compact: false },
  },
];

describe('layout conflict recovery', () => {
  it('recognizes only the canonical stale-snapshot conflict, including a wrapped cause', () => {
    expect(isBoardLayoutSnapshotStale(new Error('Board layout source snapshot is stale'))).toBe(
      true
    );
    expect(
      isBoardLayoutSnapshotStale({
        message: 'Bad request',
        cause: new Error('RepositoryError: Board layout source snapshot is stale'),
      })
    ).toBe(true);
    expect(isBoardLayoutSnapshotStale(new Error('network down'))).toBe(false);
  });

  it('rebases positions, frames, pinning, size, and density from authoritative state', () => {
    const rebased = rebaseNodesOnAuthoritativeLayout(board, [placement], nodes);

    expect(rebased).not.toBeNull();
    expect(rebased?.find((node) => node.id === 'zone')).toMatchObject({
      position: { x: 40, y: 60 },
      width: 640,
      height: 520,
    });
    expect(rebased?.find((node) => node.id === 'note')).toMatchObject({
      position: { x: 80, y: 140 },
      width: 320,
    });
    expect(rebased?.find((node) => node.id === 'branch-1')).toMatchObject({
      parentId: 'zone',
      position: { x: 20, y: 100 },
      width: 500,
      height: 220,
      data: { compact: true },
    });
  });

  it('cancels a replan when realtime has not materialized the authoritative id set', () => {
    expect(rebaseNodesOnAuthoritativeLayout(board, [placement], nodes.slice(0, 2))).toBeNull();
    expect(
      rebaseNodesOnAuthoritativeLayout(
        board,
        [placement],
        [...nodes, { id: 'branch-stale', type: 'branchNode', position: { x: 0, y: 0 }, data: {} }]
      )
    ).toBeNull();
  });

  it('cancels non-finite authoritative geometry before it reaches React Flow', () => {
    const invalid = {
      ...board,
      objects: {
        ...board.objects,
        zone: { ...board.objects?.zone, x: Number.NaN },
      },
    } as Board;
    expect(rebaseNodesOnAuthoritativeLayout(invalid, [placement], nodes)).toBeNull();
  });

  it('fetches both scoped persistence surfaces and returns one rebased source', async () => {
    const get = vi.fn().mockResolvedValue(board);
    const findAll = vi.fn().mockResolvedValue([placement]);
    const client = {
      service: vi.fn((path: string) => (path === 'boards' ? { get } : { findAll })),
    };

    const source = await fetchAuthoritativeLayoutSource(client as never, 'board-1', nodes);

    expect(get).toHaveBeenCalledWith('board-1');
    expect(findAll).toHaveBeenCalledWith({ query: { board_id: 'board-1' } });
    expect(source?.board).toBe(board);
    expect(source?.placements).toEqual([placement]);
    expect(source?.nodes.find((node) => node.id === 'branch-1')?.position).toEqual({
      x: 20,
      y: 100,
    });
  });
});
