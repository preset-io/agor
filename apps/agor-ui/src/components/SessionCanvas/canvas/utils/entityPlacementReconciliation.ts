import type { BoardEntityObject } from '@agor-live/client';

/**
 * The persisted fields that define where a branch/card belongs on a board.
 * Presentation-only placement fields (size/compact) deliberately do not
 * participate: they cannot change React Flow parentage or x/y coordinates.
 */
export interface BoardEntityPlacementSnapshot {
  objectId: string;
  boardId: string;
  zoneId: string | null;
  x: number;
  y: number;
}

/** Capture the authoritative placement, including the meaningful "not placed" state. */
export function snapshotBoardEntityPlacement(
  placement: BoardEntityObject | undefined
): BoardEntityPlacementSnapshot | null {
  if (!placement) return null;
  return {
    objectId: placement.object_id,
    boardId: placement.board_id,
    zoneId: placement.zone_id ?? null,
    x: placement.position.x,
    y: placement.position.y,
  };
}

/**
 * Compare persisted placement authority across renders/realtime events.
 * A different object, board, zone, or coordinate is a newer placement input
 * and must beat any still-pending local absolute-position override.
 */
export function sameBoardEntityPlacement(
  left: BoardEntityPlacementSnapshot | null,
  right: BoardEntityPlacementSnapshot | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.objectId === right.objectId &&
    left.boardId === right.boardId &&
    left.zoneId === right.zoneId &&
    left.x === right.x &&
    left.y === right.y
  );
}
