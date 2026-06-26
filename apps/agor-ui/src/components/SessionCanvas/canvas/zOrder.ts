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

/**
 * Board objects must stay BELOW the branch/card layer (zIndex 500) and the
 * comment layer (1000) rendered by SessionCanvas. Clamp every reorder result
 * into [BOARD_OBJECT_Z_MIN, BOARD_OBJECT_Z_MAX] so "Bring to front" can never
 * push an object up onto (or above) a card or comment.
 */
export const BOARD_OBJECT_Z_MAX = 499;
export const BOARD_OBJECT_Z_MIN = 1;

/**
 * Coerce a persisted zIndex to an in-band number, falling back to the per-type
 * default. Guards against bad data from MCP/import writes:
 * - non-numeric / NaN / Infinity → the per-type `fallback`.
 * - a finite but out-of-band value (e.g. 600 written directly via MCP/import)
 *   is CLAMPED into [BOARD_OBJECT_Z_MIN, BOARD_OBJECT_Z_MAX] so it can never be
 *   read back as >= the card (500) / comment (1000) layers (600 → 499).
 *
 * Because reads are clamped here, the peers fed into `computeLayerChanges` are
 * already in-band; the swap branches clamp anyway as defense-in-depth.
 */
export function sanitizeZIndex(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(BOARD_OBJECT_Z_MAX, Math.max(BOARD_OBJECT_Z_MIN, value));
}

/**
 * zIndex for a board object given its base order and selection state.
 *
 * A selected object floats exactly one step above its own base so it sits above
 * same-band peers while selected, then restores to its base on deselect. Single
 * source of truth for the selection bump (used by both the SessionCanvas paint
 * pass and the onNodesChange select handler).
 *
 * The +1 bump is clamped to BOARD_OBJECT_Z_MAX: a zone legitimately at base 499
 * must not render at 500 (the card layer) while selected.
 */
export function selectedZIndex(base: number, selected: boolean): number {
  return selected ? Math.min(base + 1, BOARD_OBJECT_Z_MAX) : base;
}

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
      // Room above the highest peer: just step the target up.
      if (maxOther < BOARD_OBJECT_Z_MAX) {
        return [{ id: targetId, zIndex: maxOther + 1 }];
      }
      // Ceiling is occupied (a peer sits at the band max). We can't go above it
      // without leaving the band, so pin the target at the max and push the peers
      // that share the ceiling down one, leaving the target strictly in front.
      return [
        ...(target.zIndex === BOARD_OBJECT_Z_MAX
          ? []
          : [{ id: targetId, zIndex: BOARD_OBJECT_Z_MAX }]),
        ...others
          .filter((p) => p.zIndex >= BOARD_OBJECT_Z_MAX)
          .map((p) => ({ id: p.id, zIndex: BOARD_OBJECT_Z_MAX - 1 })),
      ];
    }
    case 'back': {
      const minOther = Math.min(...others.map((p) => p.zIndex));
      if (target.zIndex < minOther) return [];
      if (minOther > BOARD_OBJECT_Z_MIN) {
        return [{ id: targetId, zIndex: minOther - 1 }];
      }
      // Floor is occupied: pin the target at the min and push the peers that share
      // the floor up one, leaving the target strictly at the back.
      return [
        ...(target.zIndex === BOARD_OBJECT_Z_MIN
          ? []
          : [{ id: targetId, zIndex: BOARD_OBJECT_Z_MIN }]),
        ...others
          .filter((p) => p.zIndex <= BOARD_OBJECT_Z_MIN)
          .map((p) => ({ id: p.id, zIndex: BOARD_OBJECT_Z_MIN + 1 })),
      ];
    }
    case 'forward': {
      // Nearest peer strictly above the target.
      const above = others
        .filter((p) => p.zIndex > target.zIndex)
        .sort((a, b) => a.zIndex - b.zIndex)[0];
      if (above) {
        // Defense-in-depth: clamp both sides of the swap into the band so no
        // path can emit an out-of-band zIndex even if a peer slipped through.
        return [
          { id: targetId, zIndex: Math.min(above.zIndex, BOARD_OBJECT_Z_MAX) },
          { id: above.id, zIndex: Math.max(target.zIndex, BOARD_OBJECT_Z_MIN) },
        ];
      }
      // No strictly-higher peer. If a peer SHARES our zIndex (the headline
      // "two zones both at the default 100" case) break the tie by stepping up
      // one — otherwise the button would silently do nothing.
      const tied = others.filter((p) => p.zIndex === target.zIndex);
      if (tied.length === 0) return [];
      const next = Math.min(target.zIndex + 1, BOARD_OBJECT_Z_MAX);
      if (next !== target.zIndex) return [{ id: targetId, zIndex: next }];
      // At the ceiling the target can't step up, so push the tied peers down one
      // instead — the target still ends up strictly above them.
      return tied
        .filter((p) => p.zIndex - 1 >= BOARD_OBJECT_Z_MIN)
        .map((p) => ({ id: p.id, zIndex: p.zIndex - 1 }));
    }
    case 'backward': {
      // Nearest peer strictly below the target.
      const below = others
        .filter((p) => p.zIndex < target.zIndex)
        .sort((a, b) => b.zIndex - a.zIndex)[0];
      if (below) {
        // Defense-in-depth: clamp both sides of the swap into the band.
        return [
          { id: targetId, zIndex: Math.max(below.zIndex, BOARD_OBJECT_Z_MIN) },
          { id: below.id, zIndex: Math.min(target.zIndex, BOARD_OBJECT_Z_MAX) },
        ];
      }
      // Mirror of `forward`: break a tie by stepping down one.
      const tied = others.filter((p) => p.zIndex === target.zIndex);
      if (tied.length === 0) return [];
      const next = Math.max(target.zIndex - 1, BOARD_OBJECT_Z_MIN);
      if (next !== target.zIndex) return [{ id: targetId, zIndex: next }];
      // At the floor the target can't step down, so push the tied peers up one.
      return tied
        .filter((p) => p.zIndex + 1 <= BOARD_OBJECT_Z_MAX)
        .map((p) => ({ id: p.id, zIndex: p.zIndex + 1 }));
    }
    default:
      return [];
  }
}
