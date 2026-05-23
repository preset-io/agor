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
 * descendant — conversation header, search result, notification — calls
 * `useRecenterMap` to pan/zoom onto a worktree without prop-drilling a
 * callback through the App tree.
 *
 * The returned function reports back whether the worktree was actually
 * present on the current board (callers can show a fallback message when
 * the worktree lives on a different board and the camera could not move).
 */
export type RecenterMapFn = (worktreeId: string) => boolean;

interface CanvasNavigationContextValue {
  recenterRef: React.MutableRefObject<RecenterMapFn | null>;
}

const CanvasNavigationContext = createContext<CanvasNavigationContextValue | null>(null);

export function CanvasNavigationProvider({ children }: { children: ReactNode }) {
  const recenterRef = useRef<RecenterMapFn | null>(null);
  const value = useMemo(() => ({ recenterRef }), []);
  return (
    <CanvasNavigationContext.Provider value={value}>{children}</CanvasNavigationContext.Provider>
  );
}

/** Single-owner registration. Last caller to mount wins. */
export function useRegisterRecenter(fn: RecenterMapFn): void {
  const ctx = useContext(CanvasNavigationContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.recenterRef.current = fn;
    return () => {
      if (ctx.recenterRef.current === fn) {
        ctx.recenterRef.current = null;
      }
    };
  }, [ctx, fn]);
}

/** Consumer hook — safe to call outside the provider (returns a no-op). */
export function useRecenterMap(): RecenterMapFn {
  const ctx = useContext(CanvasNavigationContext);
  return useCallback(
    (worktreeId: string) => {
      const fn = ctx?.recenterRef.current;
      if (!fn) return false;
      return fn(worktreeId);
    },
    [ctx]
  );
}
