/**
 * useProgressiveMount — chunked mount scheduler for expensive card internals.
 *
 * Problem (#1768): navigating Home → board mounts every BranchCard's session
 * sections inside the same router transition. On a board with dozens of
 * branches that is a multi-second render before the canvas ever paints.
 *
 * Cards call this hook instead of mounting their heavy internals directly.
 * The first render returns `false` (the card renders a lightweight shell),
 * then a shared module-level queue releases mounts in small chunks — one
 * chunk per frame — so the canvas shell commits first and detail hydration
 * never blocks a single frame for long. Higher `priority` mounts first
 * (e.g. the URL-target card).
 */
import { useEffect, useRef, useState } from 'react';

// 3 sections per frame keeps each hydration commit well under a frame budget
// in production while still fully hydrating a 30-card board in ~10 frames.
const CHUNK_SIZE = 3;

interface PendingMount {
  priority: number;
  seq: number;
  fire: () => void;
}

let pending: PendingMount[] = [];
let pumpScheduled = false;
let seqCounter = 0;

function pump(): void {
  pumpScheduled = false;
  if (pending.length === 0) return;
  // Highest priority first; FIFO within the same priority.
  pending.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  const batch = pending.splice(0, CHUNK_SIZE);
  for (const item of batch) item.fire();
  if (pending.length > 0) schedulePump();
}

function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  if (typeof requestAnimationFrame === 'function') {
    // rAF → macrotask: let the browser paint the chunk just committed before
    // the next chunk mounts.
    requestAnimationFrame(() => setTimeout(pump, 0));
  } else {
    setTimeout(pump, 0);
  }
}

/**
 * Returns `true` once this consumer's mount slot has been granted.
 * `enabled: false` opts out of deferral entirely (always returns `true`) —
 * used by surfaces that render a single instance (side panel, popover).
 */
export function useProgressiveMount({
  enabled,
  priority = 0,
  resetKey = 'default',
}: {
  enabled: boolean;
  priority?: number;
  /**
   * Logical surface key for this mount request. Changing it replays deferral
   * for reused component instances (for example, same branch node across boards).
   */
  resetKey?: string | number | null;
}): boolean {
  const [state, setState] = useState(() => ({ ready: !enabled, resetKey }));

  // If the key changed, compute the visible value from the new key immediately
  // instead of rendering one frame with the previous board's granted state.
  const ready = state.resetKey === resetKey ? state.ready : !enabled;

  // Enqueue-time priority via ref: a later priority flip must not re-enqueue
  // (losing queue position) or re-run the effect.
  const priorityRef = useRef(priority);
  priorityRef.current = priority;

  useEffect(() => {
    if (state.resetKey !== resetKey) {
      setState({ ready: !enabled, resetKey });
      return;
    }

    if (!enabled) {
      if (!state.ready) setState({ ready: true, resetKey });
      return;
    }

    if (state.ready) return;

    let cancelled = false;
    const entry: PendingMount = {
      priority: priorityRef.current,
      seq: seqCounter++,
      fire: () => {
        if (!cancelled) {
          setState((current) =>
            current.resetKey === resetKey ? { ready: true, resetKey } : current
          );
        }
      },
    };
    pending.push(entry);
    schedulePump();
    return () => {
      cancelled = true;
      pending = pending.filter((e) => e !== entry);
    };
  }, [enabled, resetKey, state.ready, state.resetKey]);

  return ready;
}
