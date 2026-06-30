import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

/**
 * Imperative camera-nav channel for the board canvas.
 *
 * SessionCanvas (the single owner of the React Flow instance) registers its
 * recenter implementation via `useRegisterRecenter` once it mounts. Any
 * descendant — conversation header, search result, notification, settings
 * row — calls `useRecenterMap` to pan/zoom onto a board element without
 * prop-drilling a callback through the App tree.
 *
 * `nodeId` is whatever id React Flow uses for the target node. For
 * branches that's `branch_id`; the same plumbing works for any other
 * node type rendered on the canvas (artifacts, cards, comments, zones) as
 * long as the id matches the rendered node.
 *
 * Cross-board: pass `opts.boardId` to recenter on a node that lives on a
 * different board. The hook stashes the target, asks App to switch boards,
 * and the new SessionCanvas drains the pending target once its nodes load.
 *
 * Returns `true` if the camera moved synchronously or a cross-board hop is
 * in flight, `false` otherwise (no canvas mounted, unknown id, no
 * switcher).
 */
export type RecenterMapFn = (nodeId: string) => boolean;
export type RecenterOpts = { boardId?: string };
export type BoardSwitcherFn = (boardId: string) => void;
export type PanToPositionFn = (x: number, y: number) => boolean;

interface PendingRecenter {
  nodeId: string;
  expiresAt: number;
}

interface PendingPan {
  x: number;
  y: number;
  expiresAt: number;
}

interface CanvasNavigationContextValue {
  recenterRef: React.MutableRefObject<RecenterMapFn | null>;
  boardSwitcherRef: React.MutableRefObject<BoardSwitcherFn | null>;
  pendingRef: React.MutableRefObject<PendingRecenter | null>;
  panToPositionRef: React.MutableRefObject<PanToPositionFn | null>;
  pendingPanRef: React.MutableRefObject<PendingPan | null>;
}

// Pending recenter has a short TTL so a stale stash doesn't fire when a user
// later navigates to the same board manually. 5 seconds is long enough for
// the new canvas to mount and load nodes, short enough to be invisible if
// the switch fails.
const PENDING_TTL_MS = 5000;

const CanvasNavigationContext = createContext<CanvasNavigationContextValue | null>(null);

export function CanvasNavigationProvider({ children }: { children: ReactNode }) {
  const recenterRef = useRef<RecenterMapFn | null>(null);
  const boardSwitcherRef = useRef<BoardSwitcherFn | null>(null);
  const pendingRef = useRef<PendingRecenter | null>(null);
  const panToPositionRef = useRef<PanToPositionFn | null>(null);
  const pendingPanRef = useRef<PendingPan | null>(null);
  const value = useMemo(
    () => ({ recenterRef, boardSwitcherRef, pendingRef, panToPositionRef, pendingPanRef }),
    []
  );
  return (
    <CanvasNavigationContext.Provider value={value}>{children}</CanvasNavigationContext.Provider>
  );
}

/** Mount a single-owner registration into a ref. Last caller wins;
 *  unmount nulls the ref only if it still holds *this* fn (guards
 *  against a newer owner having taken over). */
function useRegisterRef<T>(ref: React.MutableRefObject<T | null> | undefined, fn: T): void {
  useEffect(() => {
    if (!ref) return;
    ref.current = fn;
    return () => {
      if (ref.current === fn) {
        ref.current = null;
      }
    };
  }, [ref, fn]);
}

/** Single-owner registration. Last caller to mount wins. */
export function useRegisterRecenter(fn: RecenterMapFn): void {
  useRegisterRef(useContext(CanvasNavigationContext)?.recenterRef, fn);
}

/** App owns the board state — register its setter so cross-board recenter
 *  can ask for a switch. */
export function useRegisterBoardSwitcher(fn: BoardSwitcherFn): void {
  useRegisterRef(useContext(CanvasNavigationContext)?.boardSwitcherRef, fn);
}

/** SessionCanvas drains the stash once its new board's nodes are ready.
 *  Returns the pending node id (and clears it) if one is live, else null. */
export function useConsumePendingRecenter(): () => string | null {
  const ctx = useContext(CanvasNavigationContext);
  return useCallback(() => {
    const pending = ctx?.pendingRef.current;
    if (!pending) return null;
    if (Date.now() > pending.expiresAt) {
      ctx!.pendingRef.current = null;
      return null;
    }
    ctx!.pendingRef.current = null;
    return pending.nodeId;
  }, [ctx]);
}

/** Consumer hook — safe to call outside the provider (returns a no-op). */
export function useRecenterMap(): (nodeId: string, opts?: RecenterOpts) => boolean {
  const ctx = useContext(CanvasNavigationContext);
  return useCallback(
    (nodeId: string, opts?: RecenterOpts) => {
      if (!ctx) return false;
      // Try a synchronous recenter first — covers the common case where the
      // target is on the visible board (or the caller didn't bother to look
      // up `boardId`).
      const sync = ctx.recenterRef.current?.(nodeId);
      if (sync) return true;
      // Cross-board: stash + switch if we have a target board and a switcher.
      if (opts?.boardId && ctx.boardSwitcherRef.current) {
        ctx.pendingRef.current = {
          nodeId,
          expiresAt: Date.now() + PENDING_TTL_MS,
        };
        ctx.boardSwitcherRef.current(opts.boardId);
        return true;
      }
      return false;
    },
    [ctx]
  );
}

/** SessionCanvas registers its setCenter implementation so callers can pan to
 *  arbitrary flow coordinates (e.g. a remote user's cursor position). */
export function useRegisterPanToPosition(fn: PanToPositionFn): void {
  useRegisterRef(useContext(CanvasNavigationContext)?.panToPositionRef, fn);
}

/** SessionCanvas drains a pending coordinate pan after a board switch loads. */
export function useConsumePendingPan(): () => { x: number; y: number } | null {
  const ctx = useContext(CanvasNavigationContext);
  return useCallback(() => {
    const pending = ctx?.pendingPanRef.current;
    if (!pending) return null;
    if (Date.now() > pending.expiresAt) {
      ctx!.pendingPanRef.current = null;
      return null;
    }
    ctx!.pendingPanRef.current = null;
    return { x: pending.x, y: pending.y };
  }, [ctx]);
}

/** Consumer hook — pan the canvas to flow coordinates (x, y).
 *  Handles cross-board: if the target is on a different board, switches first
 *  and lets SessionCanvas drain the pending pan on mount. */
export function usePanToPosition(): (x: number, y: number, opts?: { boardId?: string }) => boolean {
  const ctx = useContext(CanvasNavigationContext);
  return useCallback(
    (x: number, y: number, opts?: { boardId?: string }) => {
      if (!ctx) return false;
      // Try synchronous pan first (canvas is already showing the right board).
      const sync = ctx.panToPositionRef.current?.(x, y);
      if (sync) return true;
      // Cross-board: stash + switch board so the new SessionCanvas drains it.
      if (opts?.boardId && ctx.boardSwitcherRef.current) {
        ctx.pendingPanRef.current = {
          x,
          y,
          expiresAt: Date.now() + PENDING_TTL_MS,
        };
        ctx.boardSwitcherRef.current(opts.boardId);
        return true;
      }
      return false;
    },
    [ctx]
  );
}
