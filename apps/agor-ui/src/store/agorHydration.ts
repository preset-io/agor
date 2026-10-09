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

// Collections with a live-write revision counter (`liveRevisions`): the ones a
// background hydration (`runHydration`) still replaces wholesale, and the ones
// first paint, a resync or a partition load fence per id. Each has its own
// counter so a write to one collection never blocks another's load.
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
  | 'oauth'
  | 'agenticToolSettings';

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
  agenticToolSettings: 0,
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

// The collections `runHydration` still replaces wholesale; only they carry a
// generation token.
export type BackgroundHydratedCollection = Extract<
  HydratedCollection,
  'agenticToolSettings' | 'mcpServers' | 'gatewayChannels' | 'artifacts' | 'comments'
>;

// Per-collection hydration generation tokens. Each `runHydration` call bumps the
// generation for the collection(s) it owns and captures it; its retry loop stops
// (without applying a snapshot or scheduling another timer) the moment a newer
// hydration supersedes it (a reconnect-triggered refetch), the component
// unmounts, or a logout reset fires — all of which bump these counters. This is
// CANCELLATION, not race reconciliation: clobber-safety still comes entirely
// from the quiet-window check against `liveRevisions`. Kept strictly monotonic.
const hydrationGeneration: Record<BackgroundHydratedCollection, number> = {
  agenticToolSettings: 0,
  mcpServers: 0,
  gatewayChannels: 0,
  artifacts: 0,
  comments: 0,
};

// ── Per-ID touched fence (board partition loads) ──────────────────────────
// A board partition load never discards its snapshot (that is what lets
// `runHydration` starve under churn). Instead it fills only rows that are
// ABSENT from the store and that no live event has touched since the load
// started. Each realtime write therefore stamps the entity id with the
// collection revision it produced. Stamps are only retained while at least one
// partition load is in flight: a load captures its start revisions first, so a
// stamp recorded before any load started can never be newer than that load's
// start revision and is irrelevant.
let partitionLoadsInFlight = 0;
let touchedIds = new Map<HydratedCollection, Map<string, number>>();

// Wholesale (non-per-ID) replacement epoch. First paint replaces whole
// collections, and a reconnect resync replaces whatever a read that began
// before it saw while disconnected; a load that spans one cannot tell which
// rows that replacement removed, so it restarts instead of applying (see
// `fencedRead`). Wholesale replacements are rare, so restarting cannot starve.
let wholesaleEpoch = 0;

const stampTouched = (collection: HydratedCollection, id: string): void => {
  if (partitionLoadsInFlight === 0) return;
  let ids = touchedIds.get(collection);
  if (!ids) {
    ids = new Map();
    touchedIds.set(collection, ids);
  }
  ids.set(id, liveRevisions[collection]);
};

/**
 * Bump the live-write revision for a collection. Called by every realtime entity
 * action (and the hook's deep-link heal / OAuth handlers) that mutates one of the
 * hydrated collection Maps, so an in-flight hydration discards its snapshot
 * rather than clobbering the write. Pass the written entity's id so a load in
 * flight (first paint, a resync, a partition) keeps that row (see `touchedSince`).
 */
export const bumpRevision = (collection: HydratedCollection, id?: string): void => {
  liveRevisions[collection] += 1;
  if (id) stampTouched(collection, id);
};

/**
 * Stamp an id as touched at the CURRENT revision without bumping it. Used where
 * the bump already happened synchronously (the frame-batched session queue
 * stamps at enqueue time, right after the subscription's bump).
 */
export const markTouched = (collection: HydratedCollection, id: string): void => {
  stampTouched(collection, id);
};

/** Whether a live event wrote `id` after the given start revision. */
export const touchedSince = (
  collection: HydratedCollection,
  id: string,
  startRevision: number
): boolean => (touchedIds.get(collection)?.get(id) ?? Number.NEGATIVE_INFINITY) > startRevision;

/** Every id a live event wrote in `collection` after the given start revision. */
export const touchedIdsSince = (
  collection: HydratedCollection,
  startRevision: number
): string[] => {
  const ids: string[] = [];
  for (const [id, revision] of touchedIds.get(collection) ?? []) {
    if (revision > startRevision) ids.push(id);
  }
  return ids;
};

export interface PartitionLoadFence {
  /** Per-collection revisions captured when the load started. */
  startRevisions: Record<HydratedCollection, number>;
  /** Wholesale epoch captured when the load started. */
  epoch: number;
}

/**
 * Start retaining touched stamps for a partition load and capture its fence.
 * Every call MUST be paired with `endPartitionLoad()` (use try/finally).
 */
export const beginPartitionLoad = (): PartitionLoadFence => {
  partitionLoadsInFlight += 1;
  return { startRevisions: { ...liveRevisions }, epoch: wholesaleEpoch };
};

/** Release a partition load's hold on the touched stamps. */
export const endPartitionLoad = (): void => {
  partitionLoadsInFlight = Math.max(0, partitionLoadsInFlight - 1);
  if (partitionLoadsInFlight === 0) touchedIds = new Map();
};

/** A reconnect resync begins: every read in flight restarts (`fencedRead`). */
export const markWholesaleReplacement = (): void => {
  wholesaleEpoch += 1;
};

/** Restarts a read gets when wholesale replacements keep landing mid-read. */
export const MAX_WHOLESALE_RESTARTS = 3;

/**
 * A read whose every attempt spanned a wholesale replacement. Its snapshot is
 * never applied (it could resurrect rows the replacement removed); the caller
 * surfaces a retryable failure instead.
 */
export class WholesaleReplacementError extends Error {
  constructor() {
    super('Data was replaced while loading; retry');
    this.name = 'WholesaleReplacementError';
  }
}

/** Returned by a `fencedRead` apply to send the read again. */
export const RESTART_READ: unique symbol = Symbol('restart read');

/** The touched fence of one `fencedRead` attempt. */
export interface ReadFence {
  readonly startRevisions: Record<HydratedCollection, number>;
  /** Whether a live event wrote `id` since the read began. */
  touched(collection: HydratedCollection, id: string): boolean;
  /** Every id a live event wrote in `collection` since the read began. */
  touchedIds(collection: HydratedCollection): string[];
  /** Whether a wholesale replacement landed since the read began. */
  replaced(): boolean;
}

/**
 * The one fenced read every store load uses: capture the touched fence, read,
 * drop the result once `isCurrent` turns false, and otherwise `apply` it with
 * the fence, so rows written live since the read began keep their live value.
 * A read that spanned a wholesale replacement is sent again — an `apply`
 * that awaits returns `RESTART_READ` when `fence.replaced()` — and after
 * `MAX_WHOLESALE_RESTARTS` fails with `WholesaleReplacementError`. Resolves
 * the apply's result, or `null` once no longer current; read errors propagate.
 */
export async function fencedRead<T, R>(
  read: () => Promise<T>,
  apply: (rows: T, fence: ReadFence) => R | typeof RESTART_READ | Promise<R | typeof RESTART_READ>,
  isCurrent: () => boolean
): Promise<R | null> {
  for (let attempt = 0; ; attempt++) {
    const { startRevisions, epoch } = beginPartitionLoad();
    try {
      const rows = await read();
      if (!isCurrent()) return null;
      const fence: ReadFence = {
        startRevisions,
        touched: (collection, id) => touchedSince(collection, id, startRevisions[collection]),
        touchedIds: (collection) => touchedIdsSince(collection, startRevisions[collection]),
        replaced: () => wholesaleEpoch !== epoch,
      };
      const result = fence.replaced() ? RESTART_READ : await apply(rows, fence);
      if (result !== RESTART_READ) return result;
      if (!isCurrent()) return null;
      if (attempt >= MAX_WHOLESALE_RESTARTS) throw new WholesaleReplacementError();
    } finally {
      endPartitionLoad();
    }
  }
}

/** Current live-write revision for a collection. */
export const getRevision = (collection: HydratedCollection): number => liveRevisions[collection];

/**
 * Bump the revisions of every collection a non-runHydration wholesale merge
 * overwrites (gated first-paint apply + silent reconnect resync). Mirrors the
 * per-mutation handlers so an in-flight hydration whose snapshot predates the
 * merge fails its quiet check and discards.
 */
export const bumpFirstPaintMergeRevisions = (): void => {
  for (const c of FIRST_PAINT_MERGE_COLLECTIONS) liveRevisions[c] += 1;
  wholesaleEpoch += 1;
};

/**
 * Reset the live-write revision baseline to zero. Called by `useAgorData` on
 * (re)mount to mirror the fresh-`useRef` semantics it replaced. Generations are
 * deliberately NOT reset here (they stay monotonic — see module header).
 */
export const resetHydrationRevisions = (): void => {
  liveRevisions = makeZeroCounters();
  touchedIds = new Map();
  wholesaleEpoch += 1;
};

// Monotonic epoch of load lifetimes (`loadLifetime.ts`). Every cancellation
// path bumps it, so work deferred past an await that outlives its load
// (unmount, authority change, logout) is skipped instead of applying.
let cancellationEpoch = 0;

/** Current cancellation epoch; capture before deferring a hydration start. */
export const getHydrationCancellationEpoch = (): number => cancellationEpoch;

/**
 * Cancel every in-flight hydration loop by bumping all generation tokens. Used
 * on unmount (and defensively on mount) so a loop stops retrying and never
 * applies a snapshot or schedules another timer after teardown.
 */
export const cancelAllHydrations = (): void => {
  cancellationEpoch += 1;
  for (const c of Object.keys(hydrationGeneration) as BackgroundHydratedCollection[]) {
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
  cancellationEpoch += 1;
  for (const c of Object.keys(liveRevisions) as HydratedCollection[]) liveRevisions[c] += 1;
  for (const c of Object.keys(hydrationGeneration) as BackgroundHydratedCollection[]) {
    hydrationGeneration[c] += 1;
  }
  wholesaleEpoch += 1;
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
  collections: readonly BackgroundHydratedCollection[],
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
