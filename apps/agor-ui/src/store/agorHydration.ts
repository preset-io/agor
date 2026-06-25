/**
 * Background-hydration bookkeeping for the Agor store.
 *
 * The `liveRevisions` / `hydrationGeneration` counters and `runHydration` live
 * as NON-REACTIVE module-level state alongside the store. Two reasons it is
 * module-level rather than zustand state:
 *  1. The realtime entity actions (`agorRealtimeActions`) are module singletons —
 *     they MUST be able to bump the per-collection counter without a React hook.
 *  2. These counters bump on EVERY socket event (the hot path); making them
 *     subscribable store fields would re-render every `useStore(agorStore)`
 *     consumer on each bump. So they stay plain mutable module vars with
 *     `useRef` semantics — internal bookkeeping, not UI-subscribed.
 *
 * `useAgorData` is mounted once (App.tsx), so in production the module singleton
 * IS the single instance. Tests re-`renderHook` the singleton, so the hook
 * resets the revision baseline on (re)mount (`resetHydrationRevisions`) and
 * cancels any straggler loop (`cancelAllHydrations`). Generation tokens are kept
 * strictly MONOTONIC (never reset to 0) so a stale loop from a prior mount can
 * never collide with a fresh loop's generation.
 */

// Skip-apply-on-race background hydration retry schedule. A hydration applies
// its full-set snapshot ONLY if no live write to the target collection(s)
// raced the fetch (proven via the per-collection `liveRevisions` counters);
// if one did, the snapshot is DISCARDED and refetched from a fresh revision
// baseline — never overlaid/reconciled.
//
// It retries UNTIL it lands a quiet window, and NEVER gives up: skipping the
// apply forever would leave Home empty/incomplete indefinitely on a busy
// workspace, because live subscriptions deliver only CHANGES, not a backfill of
// existing rows (board switching doesn't refetch, and a reconnect may never
// fire). The first few retries are immediate (the race window is ~one fetch RTT,
// so a single transient race converges instantly), then capped exponential
// backoff lets a sustained live-write burst settle without busy-looping. Each
// retry RE-snapshots the revision and RE-fetches; a racy snapshot is never
// force-applied. Per-collection quiet windows are short, so this converges fast
// (branches almost immediately; sessions once their write churn quiets).
//
// Delays PRECEDE the attempt they guard (the delay for attempt N runs before
// fetch N, not after it). Loops are cancelled — not abandoned mid-flight — via
// the per-collection generation tokens (`hydrationGeneration`): a newer
// hydration (reconnect) or an unmount/reset supersedes older loops so they stop
// retrying and never apply a stale snapshot or leak a timer.
const HYDRATION_IMMEDIATE_RETRIES = 4;
const HYDRATION_BACKOFF_BASE_MS = 200;
const HYDRATION_BACKOFF_CAP_MS = 5000;

// Hydrated collections that the background hydration replaces wholesale. Each
// has its own live-write revision counter (`liveRevisions`) so a write to one
// collection never blocks another's hydration from applying.
export type HydratedCollection =
  | 'sessions'
  | 'branches'
  | 'boards'
  | 'boardObjects'
  | 'cards'
  | 'comments'
  | 'mcpServers'
  | 'sessionMcp'
  | 'gatewayChannels'
  | 'artifacts'
  | 'oauth';

// The collections a non-runHydration wholesale merge (the gated first-paint
// `applyMaps`, and the silent reconnect resync) overwrites — so it can bump
// their revisions exactly like the per-mutation handlers do, failing the quiet
// check of any hydration whose snapshot predates the merge.
export const FIRST_PAINT_MERGE_COLLECTIONS = [
  'sessions',
  'branches',
  'boards',
  'boardObjects',
  'cards',
  'comments',
] as const;

const makeZeroCounters = (): Record<HydratedCollection, number> => ({
  sessions: 0,
  branches: 0,
  boards: 0,
  boardObjects: 0,
  cards: 0,
  comments: 0,
  mcpServers: 0,
  sessionMcp: 0,
  gatewayChannels: 0,
  artifacts: 0,
  oauth: 0,
});

// Per-collection live-write revision counters — the core of the
// skip-apply-on-race background hydration. EVERY realtime handler that mutates
// one of these collection Maps bumps the matching counter (created / patched /
// removed, INCLUDING cascade removes such as branch eviction dropping its
// sessions, the deep-link-healing effect, and reconnect-driven writes). A
// background hydration snapshots the counters for the collections it replaces,
// fetches the full set, then applies the snapshot WHOLESALE only if those
// counters are unchanged when the fetch resolves — proving no live write raced.
// If any raced, the snapshot is discarded and refetched (never overlaid). This
// makes a wholesale apply provably unable to clobber a live write OR resurrect a
// removed entity: a remove would have bumped the counter, so no apply happens.
let liveRevisions = makeZeroCounters();

// Per-collection hydration generation tokens. Each `runHydration` call bumps the
// generation for the collection(s) it owns and captures it; its retry loop stops
// (without applying a snapshot or scheduling another timer) the moment a newer
// hydration supersedes it (a reconnect-triggered refetch), the component
// unmounts, or a logout reset fires — all of which bump these counters. This is
// CANCELLATION, not race reconciliation: clobber-safety still comes entirely
// from the quiet-window check against `liveRevisions`. Kept strictly monotonic.
const hydrationGeneration = makeZeroCounters();

/**
 * Bump the live-write revision for a collection. Called by every realtime entity
 * action (and the hook's deep-link heal / OAuth handlers) that mutates one of the
 * hydrated collection Maps, so an in-flight hydration discards its snapshot
 * rather than clobbering the write.
 */
export const bumpRevision = (collection: HydratedCollection): void => {
  liveRevisions[collection] += 1;
};

/**
 * Bump the revisions of every collection a non-runHydration wholesale merge
 * overwrites (gated first-paint apply + silent reconnect resync). Mirrors the
 * per-mutation handlers so an in-flight hydration whose snapshot predates the
 * merge fails its quiet check and discards.
 */
export const bumpFirstPaintMergeRevisions = (): void => {
  for (const c of FIRST_PAINT_MERGE_COLLECTIONS) liveRevisions[c] += 1;
};

/**
 * Reset the live-write revision baseline to zero. Called by `useAgorData` on
 * (re)mount to mirror the fresh-`useRef` semantics it replaced. Generations are
 * deliberately NOT reset here (they stay monotonic — see module header).
 */
export const resetHydrationRevisions = (): void => {
  liveRevisions = makeZeroCounters();
};

/**
 * Cancel every in-flight hydration loop by bumping all generation tokens. Used
 * on unmount (and defensively on mount) so a loop stops retrying and never
 * applies a snapshot or schedules another timer after teardown.
 */
export const cancelAllHydrations = (): void => {
  for (const c of Object.keys(hydrationGeneration) as HydratedCollection[]) {
    hydrationGeneration[c] += 1;
  }
};

/**
 * Logout teardown: cancel every in-flight hydration loop (bump generations) AND
 * fail any quiet check it might still reach (bump revisions) so an unresolved
 * hydration can't repopulate the Maps AFTER logout (post-logout data leak).
 * Bumping the generation is the real stop — without it, a revision bump alone
 * would only make the loop discard-and-RE-FETCH from the stale client and
 * eventually apply into freshly-cleared Maps.
 */
export const cancelAndFailAllHydrations = (): void => {
  for (const c of Object.keys(hydrationGeneration) as HydratedCollection[]) {
    hydrationGeneration[c] += 1;
    liveRevisions[c] += 1;
  }
};

/**
 * Run a BACKGROUND (non-gated) hydration with skip-apply-on-race. The fetched
 * full-set snapshot is applied WHOLESALE only if no live write to any of
 * `collections` raced the fetch — proven by snapshotting each collection's
 * revision counter before the fetch and re-checking after. If a write raced, the
 * (potentially stale) snapshot is DISCARDED and refetched from a fresh baseline;
 * we NEVER overlay or reconcile a racy snapshot. It retries until it lands a
 * quiet window — a few immediate retries then capped exponential backoff — and
 * never gives up (skipping forever could leave Home empty/incomplete
 * indefinitely; live events only deliver changes, not backfill). The loop is
 * cancelled — not abandoned — on supersession (reconnect), unmount, or logout
 * reset. `fetchFn` closes over the client and
 * `apply` over the store, so this helper itself touches neither.
 */
export async function runHydration<T>(
  label: string,
  collections: readonly HydratedCollection[],
  fetchFn: () => Promise<T>,
  apply: (result: T) => void
): Promise<void> {
  // Supersede any older loop for these collections and capture our generation
  // token. The loop bails the instant a newer hydration (reconnect), an unmount,
  // or a logout reset bumps the generation — so it never applies a stale snapshot
  // or schedules another timer after it's been cancelled.
  const myGeneration = collections.map((c) => (hydrationGeneration[c] += 1));
  const isCurrent = () => collections.every((c, i) => hydrationGeneration[c] === myGeneration[i]);
  // Delay PRECEDING attempt N: the first HYDRATION_IMMEDIATE_RETRIES attempts
  // fire back-to-back (delay 0) so a single transient race converges instantly;
  // after that, capped exponential backoff lets a sustained write burst settle.
  const delayBeforeAttempt = (attempt: number) =>
    attempt < HYDRATION_IMMEDIATE_RETRIES
      ? 0
      : Math.min(
          HYDRATION_BACKOFF_BASE_MS * 2 ** (attempt - HYDRATION_IMMEDIATE_RETRIES),
          HYDRATION_BACKOFF_CAP_MS
        );

  // Retry until a quiet-window apply SUCCEEDS (or the loop is cancelled). We
  // never force-apply a racy snapshot — we just keep re-snapshotting and
  // re-fetching until no live write races a fetch.
  for (let attempt = 0; ; attempt++) {
    const delayMs = delayBeforeAttempt(attempt);
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      if (!isCurrent()) return; // superseded while waiting
    }
    const before = collections.map((c) => liveRevisions[c]);
    let result: T;
    try {
      result = await fetchFn();
    } catch (err) {
      console.warn(`[useAgorData] background ${label} fetch failed:`, err);
      if (!isCurrent()) return; // superseded while fetching
      // A failed fetch leaves the collection un-hydrated; retrying (with backoff)
      // is exactly what keeps Home from staying empty forever.
      continue;
    }
    if (!isCurrent()) return; // superseded while fetching
    const raced = collections.some((c, i) => liveRevisions[c] !== before[i]);
    if (!raced) {
      apply(result);
      return;
    }
    // A live write to one of these collections raced the fetch — discard this
    // snapshot and retry from a fresh revision baseline (the next iteration's
    // delay precedes its fetch).
  }
}
