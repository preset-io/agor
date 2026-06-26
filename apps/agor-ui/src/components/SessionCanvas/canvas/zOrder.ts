/**
 * Z-order (stacking) helpers for board objects.
 *
 * Board objects (zones, text, markdown, apps, artifacts) live in the
 * `board.objects` JSON blob and may carry an explicit `zIndex`. When unset, the
 * per-type default below applies — these mirror the values that were previously
 * hardcoded in `useBoardObjects.getBoardObjectNodes`, so behavior is unchanged
 * until a user explicitly reorders something.
 *
 * Branches/cards (the separate `board_objects` DB model, zIndex 500) and
 * comments (1000) are NOT board objects and are intentionally excluded from the
 * reorder peer set.
 */

import type { BoardObjectType } from '@agor-live/client';

/** Default stacking order per board-object type (matches legacy hardcoded values). */
export const DEFAULT_BOARD_OBJECT_Z_INDEX: Record<BoardObjectType, number> = {
  zone: 100,
  markdown: 300,
  app: 400,
  artifact: 400,
  // Text objects historically rendered alongside zones; keep them at the zone layer.
  text: 100,
};

/** Layer operations available from the zone toolbar. */
export type LayerOp = 'front' | 'forward' | 'backward' | 'back';

/** A board object considered for relative stacking. */
export interface ZPeer {
  id: string;
  zIndex: number;
}

/** A resulting zIndex assignment to persist. */
export interface ZChange {
  id: string;
  zIndex: number;
}

/**
 * Compute the zIndex change(s) needed to apply a layer operation to one object
 * relative to its peers.
 *
 * - `front` / `back`: a single change moving the target above/below all peers.
 * - `forward` / `backward`: a swap with the nearest peer above/below (two
 *   changes), so the move is exactly one step and stays deterministic even when
 *   zIndex values are sparse.
 *
 * Returns an empty array when the operation is a no-op (no peers, or the target
 * is already at the requested extreme / has no neighbor to swap with).
 *
 * `peers` MUST include the target itself.
 */
export function computeLayerChanges(op: LayerOp, targetId: string, peers: ZPeer[]): ZChange[] {
  const target = peers.find((p) => p.id === targetId);
  if (!target) return [];

  const others = peers.filter((p) => p.id !== targetId);
  if (others.length === 0) return [];

  switch (op) {
    case 'front': {
      const maxOther = Math.max(...others.map((p) => p.zIndex));
      // Already strictly in front of everything → nothing to do.
      if (target.zIndex > maxOther) return [];
      return [{ id: targetId, zIndex: maxOther + 1 }];
    }
    case 'back': {
      const minOther = Math.min(...others.map((p) => p.zIndex));
      if (target.zIndex < minOther) return [];
      return [{ id: targetId, zIndex: minOther - 1 }];
    }
    case 'forward': {
      // Nearest peer strictly above the target.
      const above = others
        .filter((p) => p.zIndex > target.zIndex)
        .sort((a, b) => a.zIndex - b.zIndex)[0];
      if (!above) return [];
      return [
        { id: targetId, zIndex: above.zIndex },
        { id: above.id, zIndex: target.zIndex },
      ];
    }
    case 'backward': {
      // Nearest peer strictly below the target.
      const below = others
        .filter((p) => p.zIndex < target.zIndex)
        .sort((a, b) => b.zIndex - a.zIndex)[0];
      if (!below) return [];
      return [
        { id: targetId, zIndex: below.zIndex },
        { id: below.id, zIndex: target.zIndex },
      ];
    }
  }
}
