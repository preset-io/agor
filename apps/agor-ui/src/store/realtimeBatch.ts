/**
 * Coalesce high-frequency realtime store updates into one flush per animation
 * frame.
 *
 * Streaming agents emit a `session:patched` on every token batch. Applied
 * synchronously — one zustand `set()` → one React notification each — they fire
 * dozens of times per second. That is harmless once a board is mounted (each
 * notification only re-renders the one BranchCard whose bucket changed), but it
 * is catastrophic *while a board is mounting*: home→board mounts the whole
 * canvas into a live, fully-hydrated store, and every mid-mount store mutation
 * makes React re-run the in-flight render before it can settle. On a busy
 * workspace (many agents streaming across all boards) the mount never converges
 * — this is the ~15-20s home→board stall. A raw/direct board load doesn't hit
 * it because its first paint is board-scoped and goes through the quiet
 * first-paint gate.
 *
 * Batching defers each wrapped action to the next frame and runs the whole queue
 * in a single task, so React batches them into ONE re-render per frame. The
 * mount then gets whole frames to itself and settles quickly.
 *
 * Ordering is preserved (FIFO). Reducers already bail when their target entity
 * is gone (`sessionPatched` no-ops when the id isn't tracked), so a batched
 * patch can never resurrect a session that was removed synchronously in between.
 */

type Thunk = () => void;

let queue: Thunk[] = [];
let handle: number | ReturnType<typeof setTimeout> | null = null;

const raf: ((cb: () => void) => number) | null =
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
const caf: ((h: number) => void) | null =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;

function flush(): void {
  handle = null;
  const batch = queue;
  queue = [];
  for (const run of batch) run();
}

function schedule(): void {
  if (handle != null) return;
  handle = raf ? raf(flush) : setTimeout(flush, 0);
}

/**
 * Wrap a realtime action so its store write is deferred to the next coalesced
 * flush. The returned handler is stable for the life of the wrap, so the SAME
 * reference must be used for `service.on(...)` and `service.removeListener(...)`.
 */
export function batchRealtime<T>(action: (payload: T) => void): (payload: T) => void {
  return (payload: T) => {
    queue.push(() => action(payload));
    schedule();
  };
}

/**
 * Apply any queued updates immediately. Call on teardown so a pending flush
 * isn't lost when the subscription effect unmounts.
 */
export function flushRealtimeNow(): void {
  if (handle == null && queue.length === 0) return;
  if (handle != null) {
    if (raf && caf) caf(handle as number);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
    handle = null;
  }
  flush();
}
