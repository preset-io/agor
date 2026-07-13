/**
 * Tests for `useAgorData` socket-event handling. The focus is on the
 * subscription side of the hook (event handlers + state bailouts) — the
 * initial /findAll fetch lives in `fetchData()` and is tested implicitly
 * by populating the byId Maps with the initial response.
 *
 * Why this exists: socket events arrive at high frequency (especially when
 * agents are streaming). Even when an event is a no-op for the central
 * store (idempotent patch, archive event for an unknown id, etc.), an
 * earlier bug always produced a fresh `maps` reference, cascading
 * re-renders into the board canvas. These tests pin down the bailout
 * contract: if an event doesn't change byId content, the entity map
 * references in the store are stable.
 *
 * The hook itself returns only load-state (it no longer surfaces the entity
 * maps); the maps live in `agorStore`, so map assertions read them via
 * `agorStore.getState().<map>` while load-state reads stay on `result.current`.
 */
import type { Link } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { agorStore } from '../store/agorStore';
// Session `patched`/`updated` writes are coalesced to one flush per frame (see
// realtimeBatch); flush synchronously in tests that assert the post-patch store.
import { flushRealtimeNow } from '../store/realtimeBatch';
import { useAgorData } from './useAgorData';

/**
 * Minimal AgorClient stand-in. Implements just enough of the service /
 * socket surface the hook touches:
 *   - `service(name).findAll({...})` — initial fetch, returns the
 *     pre-seeded list for that service (default empty).
 *   - `service(name).on/removeListener` — wires up event handlers we
 *     dispatch from tests via `emit(name, event, payload)`.
 *   - `service(name).get(id)` — only used by the OAuth refetch path,
 *     resolves with whatever the test stubbed.
 *   - `io.on/off` — captures connect / oauth listeners; tests don't
 *     trigger reconnect refetches.
 *
 * Anything we don't model is left as a noop or absent — the hook handles
 * its own optional-feature paths.
 */
type Listener = (payload: unknown) => void;

/**
 * `seed` is keyed by service name (e.g. `sessions`) and consulted by both
 * `findAll` and `find`. For the background-hydration tests the gated first-paint
 * fetch (`find`) and the full hydration fetch (`findAll`) need DIFFERENT data,
 * so a method-specific key (`sessions:findAll`, `sessions:find`) takes
 * precedence over the bare name when present. `name:get` seeds `get`.
 */
function makeMockClient(seed: Record<string, unknown[]> = {}) {
  const serviceListeners = new Map<string, Map<string, Listener[]>>();
  const ioListeners = new Map<string, Listener[]>();
  // Side effects fired at call time of `service(name)[method]()` — used by the
  // skip-apply-on-race tests to inject a live write mid-fetch. If the hook
  // returns a thenable, `respond` AWAITS it before resolving, which lets a test
  // hold a fetch in-flight (e.g. to fire a reconnect / logout while a hydration
  // is pending). The response data is the array reference captured at CALL time
  // (before the await), so a test can swap `seed[key]` to make a later call see
  // a different set than an earlier deferred one.
  const fetchHooks = new Map<string, (call: number) => unknown>();
  const fetchCounts = new Map<string, number>();

  const respond = async (name: string, method: 'findAll' | 'find') => {
    const key = `${name}:${method}`;
    const call = (fetchCounts.get(key) ?? 0) + 1;
    fetchCounts.set(key, call);
    const gate = fetchHooks.get(key)?.(call);
    const data = seed[key] ?? seed[name] ?? [];
    if (gate && typeof (gate as { then?: unknown }).then === 'function') {
      await gate;
    }
    return data;
  };

  const service = (name: string) => ({
    findAll: vi.fn(() => respond(name, 'findAll')),
    find: vi.fn(() => respond(name, 'find')),
    get: vi.fn().mockResolvedValue(seed[`${name}:get`] ?? null),
    on: (event: string, fn: Listener) => {
      let svc = serviceListeners.get(name);
      if (!svc) {
        svc = new Map();
        serviceListeners.set(name, svc);
      }
      const arr = svc.get(event) ?? [];
      arr.push(fn);
      svc.set(event, arr);
    },
    removeListener: (event: string, fn: Listener) => {
      const svc = serviceListeners.get(name);
      if (!svc) return;
      const arr = svc.get(event) ?? [];
      svc.set(
        event,
        arr.filter((f) => f !== fn)
      );
    },
  });

  return {
    client: {
      service,
      io: {
        on: (event: string, fn: Listener) => {
          const arr = ioListeners.get(event) ?? [];
          arr.push(fn);
          ioListeners.set(event, arr);
        },
        off: (event: string, fn: Listener) => {
          const arr = ioListeners.get(event) ?? [];
          ioListeners.set(
            event,
            arr.filter((f) => f !== fn)
          );
        },
      },
    } as never,
    emit: (svc: string, event: string, payload: unknown) => {
      for (const fn of serviceListeners.get(svc)?.get(event) ?? []) fn(payload);
    },
    // Fire an `io` event (e.g. `connect`) so tests can drive the reconnect
    // refetch path.
    emitIo: (event: string) => {
      for (const fn of ioListeners.get(event) ?? []) fn(undefined);
    },
    // Register a synchronous side effect that runs every time `service(name)`'s
    // `method` is invoked (receives the 1-based call count). The hook fires
    // BEFORE the returned promise resolves, so emitting a live event here lands
    // a write DURING the fetch window — exactly the race the hydration guards.
    onFetch: (name: string, method: 'findAll' | 'find', fn: (call: number) => unknown) =>
      fetchHooks.set(`${name}:${method}`, fn),
    fetchCount: (name: string, method: 'findAll' | 'find') =>
      fetchCounts.get(`${name}:${method}`) ?? 0,
  };
}

const makeBranch = (overrides: Record<string, unknown> = {}) => ({
  branch_id: 'b-1',
  repo_id: 'r-1',
  name: 'main',
  status: 'idle',
  archived: false,
  ...overrides,
});

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  session_id: 's-1',
  branch_id: 'b-1',
  status: 'idle',
  archived: false,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const makeLink = (overrides: Record<string, unknown> = {}) =>
  ({
    link_id: 'l-1',
    branch_id: 'b-1',
    session_id: null,
    kind: 'url',
    source: 'manual',
    url: 'https://example.com',
    target_key: 'url:https://example.com',
    is_pinned: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }) as Link;

const makeBoardObject = (overrides: Record<string, unknown> = {}) => ({
  object_id: 'bo-1',
  board_id: 'board-1',
  branch_id: 'b-1',
  entity_type: 'branch',
  position: { x: 10, y: 20 },
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

/**
 * Wait until the hook has finished its initial fetch AND populated the
 * byId maps. The two flip in separate setState calls — `itemCounts` is
 * updated as each tracked promise resolves (driving `initialLoadComplete`)
 * while the byId Maps are populated after the `Promise.all` body runs —
 * so we gate on `loading === false` which only flips inside the same
 * `finally` block as the map writes.
 */
async function waitForInitialLoad(result: { current: ReturnType<typeof useAgorData> }) {
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
    expect(result.current.initialLoadComplete).toBe(true);
  });
  // The first paint opens the gate, but the background hydration (sessions +
  // branches, plus the optional mcp/gateway/artifact/oauth slices) is kicked
  // off right after and applies a beat later — replacing those map slices
  // WHOLESALE with the full snapshot, which changes their references even when
  // content is identical. Flush a macrotask so it settles before tests capture
  // baseline references or emit events, otherwise reference-stability and
  // mutation assertions would race the hydration apply.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

// Flush pending microtasks + a macrotask inside `act`, so background hydration
// retries / applies (and reconnect / reset effects) settle before assertions.
async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

// A promise a test can resolve on demand — returned from an `onFetch` hook to
// hold a fetch in-flight (so a reconnect / logout can land while a hydration is
// still pending).
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useAgorData — socket-event bailouts', () => {
  it('hydrates a direct archived session by id without broadening active board lists', async () => {
    const archivedSession = makeSession({
      session_id: 's-archived-full',
      branch_id: 'b-archived',
      archived: true,
    });
    const archivedBranch = makeBranch({
      branch_id: 'b-archived',
      archived: true,
      board_id: 'board-archived',
    });
    const { client } = makeMockClient({
      // Initial lists model the normal active-only fetches: the archived
      // target is omitted until the direct /s/<id> fallback asks for it.
      sessions: [],
      branches: [],
      'sessions:get': archivedSession,
      'branches:get': archivedBranch,
    });

    const { result } = renderHook(() => useAgorData(client, { directSessionId: 's-archived' }));
    await waitForInitialLoad(result);

    expect(agorStore.getState().sessionById.get('s-archived-full')).toMatchObject({
      archived: true,
      branch_id: 'b-archived',
    });
    expect(agorStore.getState().sessionsByBranch.has('b-archived')).toBe(false);
    expect(agorStore.getState().branchById.has('b-archived')).toBe(false);
  });

  it('drops a duplicate `sessions.patched` (content-equal) without changing byId references', async () => {
    const session = makeSession();
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeSessions = agorStore.getState().sessionById;
    const beforeByBranch = agorStore.getState().sessionsByBranch;

    // Feathers re-emits a fresh object on every patch — same content,
    // different reference. The hook MUST bail out (no-op patch).
    act(() => emit('sessions', 'patched', { ...session }));

    expect(agorStore.getState().sessionById).toBe(beforeSessions);
    expect(agorStore.getState().sessionsByBranch).toBe(beforeByBranch);
  });

  it('updates byId references when a session field actually changes', async () => {
    const session = makeSession({ status: 'idle' });
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeSessions = agorStore.getState().sessionById;

    act(() => {
      emit('sessions', 'patched', { ...session, status: 'running' });
      flushRealtimeNow();
    });

    expect(agorStore.getState().sessionById).not.toBe(beforeSessions);
    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({ status: 'running' });
  });

  it('updates branch-card session buckets when stop patches a running session idle', async () => {
    const session = makeSession({ status: 'running', ready_for_prompt: false });
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    act(() => {
      emit('sessions', 'patched', {
        ...session,
        status: 'idle',
        ready_for_prompt: true,
      });
      flushRealtimeNow();
    });

    expect(agorStore.getState().sessionById.get('s-1')).toMatchObject({
      status: 'idle',
      ready_for_prompt: true,
    });
    expect(agorStore.getState().sessionsByBranch.get('b-1')?.[0]).toMatchObject({
      status: 'idle',
      ready_for_prompt: true,
    });
  });

  it('ignores `sessions.removed` for a session not in the map', async () => {
    const { client, emit } = makeMockClient();
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeSessions = agorStore.getState().sessionById;
    const beforeByBranch = agorStore.getState().sessionsByBranch;

    act(() => emit('sessions', 'removed', makeSession({ session_id: 'unknown' })));

    expect(agorStore.getState().sessionById).toBe(beforeSessions);
    expect(agorStore.getState().sessionsByBranch).toBe(beforeByBranch);
  });

  it('drops a no-op `branches.patched` (idempotent content)', async () => {
    const branch = makeBranch();
    const { client, emit } = makeMockClient({ branches: [branch] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const before = agorStore.getState().branchById;
    act(() => emit('branches', 'patched', { ...branch }));
    expect(agorStore.getState().branchById).toBe(before);
  });

  it('updates branchById when a branch field flips', async () => {
    const branch = makeBranch({ name: 'main' });
    const { client, emit } = makeMockClient({ branches: [branch] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const before = agorStore.getState().branchById;
    act(() => emit('branches', 'patched', { ...branch, name: 'feature/x' }));

    expect(agorStore.getState().branchById).not.toBe(before);
    expect(agorStore.getState().branchById.get('b-1')?.name).toBe('feature/x');
  });

  it('evicts an archived branch and its sessions on branches.patched', async () => {
    const branch = makeBranch();
    const session = makeSession();
    const { client, emit } = makeMockClient({ branches: [branch], sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(agorStore.getState().branchById.has('b-1')).toBe(true);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);

    act(() => emit('branches', 'patched', { ...branch, archived: true }));

    expect(agorStore.getState().branchById.has('b-1')).toBe(false);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(false);
  });

  it('drops a duplicate `sessions.created` for an existing id', async () => {
    const session = makeSession();
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeSessions = agorStore.getState().sessionById;
    const beforeByBranch = agorStore.getState().sessionsByBranch;

    act(() => emit('sessions', 'created', { ...session }));

    expect(agorStore.getState().sessionById).toBe(beforeSessions);
    expect(agorStore.getState().sessionsByBranch).toBe(beforeByBranch);
  });

  it('keeps unrelated byId maps reference-stable across a session patch', async () => {
    const session = makeSession({ status: 'idle' });
    const branch = makeBranch();
    const { client, emit } = makeMockClient({ sessions: [session], branches: [branch] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeBranches = agorStore.getState().branchById;
    const beforeBoards = agorStore.getState().boardById;
    const beforeUsers = agorStore.getState().userById;

    act(() => emit('sessions', 'patched', { ...session, status: 'running' }));

    // Only sessionById / sessionsByBranch flip — the rest must stay put so
    // their consumers (SessionCanvas, boards UI, user settings) don't
    // needlessly re-render.
    expect(agorStore.getState().branchById).toBe(beforeBranches);
    expect(agorStore.getState().boardById).toBe(beforeBoards);
    expect(agorStore.getState().userById).toBe(beforeUsers);
  });

  it('migrates a session between branches when branch_id changes', async () => {
    const session = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(
      agorStore
        .getState()
        .sessionsByBranch.get('b-1')
        ?.map((s) => s.session_id)
    ).toEqual(['s-1']);

    act(() => {
      emit('sessions', 'patched', { ...session, branch_id: 'b-2' });
      flushRealtimeNow();
    });

    // Old branch bucket is cleaned up; new branch bucket holds the session.
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(false);
    expect(
      agorStore
        .getState()
        .sessionsByBranch.get('b-2')
        ?.map((s) => s.session_id)
    ).toEqual(['s-1']);
    expect(agorStore.getState().sessionById.get('s-1')?.branch_id).toBe('b-2');
  });

  it('evicts a branch and its sessions on `branches.removed`', async () => {
    const session = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const branch = makeBranch({ branch_id: 'b-1' });
    const { client, emit } = makeMockClient({ sessions: [session], branches: [branch] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(agorStore.getState().branchById.has('b-1')).toBe(true);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(true);

    act(() => emit('branches', 'removed', branch));

    expect(agorStore.getState().branchById.has('b-1')).toBe(false);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(false);
  });

  it('dispatches `agor:artifact-patched` when the artifact actually changes', async () => {
    const artifact = {
      artifact_id: 'a-1',
      name: 'demo',
      content_hash: 'h1',
      board_id: 'board-1',
      created_by: 'u-1',
    };
    const { client, emit } = makeMockClient({ artifacts: [artifact] });
    const events: Array<{ artifactId: string; contentHash: string }> = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('agor:artifact-patched', listener);

    try {
      const { result } = renderHook(() => useAgorData(client));
      await waitForInitialLoad(result);

      act(() => emit('artifacts', 'patched', { ...artifact, content_hash: 'h2' }));

      expect(events).toEqual([{ artifactId: 'a-1', contentHash: 'h2' }]);
      expect(agorStore.getState().artifactById.get('a-1')?.content_hash).toBe('h2');
    } finally {
      window.removeEventListener('agor:artifact-patched', listener);
    }
  });

  it('keeps `artifactById` reference-stable on a content-equal artifact patch', async () => {
    // Pin the contract: idempotent artifact patches must NOT invalidate
    // `artifactById`. The window event fires either way (consumer filters
    // by contentHash), but the central store stays put — that's what
    // protects the canvas from re-rendering on no-op artifact patches.
    const artifact = {
      artifact_id: 'a-1',
      name: 'demo',
      content_hash: 'h1',
      board_id: 'board-1',
      created_by: 'u-1',
    };
    const { client, emit } = makeMockClient({ artifacts: [artifact] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const before = agorStore.getState().artifactById;

    act(() => emit('artifacts', 'patched', { ...artifact }));

    expect(agorStore.getState().artifactById).toBe(before);
  });

  it('builds derived board-object indexes during initial load', async () => {
    const branchObject = makeBoardObject({ object_id: 'bo-branch', branch_id: 'b-1' });
    const cardObject = makeBoardObject({
      object_id: 'bo-card',
      branch_id: undefined,
      card_id: 'c-1',
      entity_type: 'card',
    });
    const otherBoardObject = makeBoardObject({
      object_id: 'bo-other',
      board_id: 'board-2',
      branch_id: 'b-2',
    });
    const { client } = makeMockClient({
      'board-objects': [branchObject, cardObject, otherBoardObject],
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(agorStore.getState().boardObjectById.get('bo-branch')).toMatchObject({
      branch_id: 'b-1',
    });
    expect(
      agorStore
        .getState()
        .boardObjectsByBoardId.get('board-1')
        ?.map((bo) => bo.object_id)
    ).toEqual(['bo-branch', 'bo-card']);
    expect(
      agorStore
        .getState()
        .boardObjectsByBoardId.get('board-2')
        ?.map((bo) => bo.object_id)
    ).toEqual(['bo-other']);
    expect(agorStore.getState().boardObjectByBranchId.get('b-1')?.object_id).toBe('bo-branch');
    expect(agorStore.getState().boardObjectByCardId.get('c-1')?.object_id).toBe('bo-card');
  });

  it('keeps board-object derived indexes in sync across patch and remove events', async () => {
    const boardObject = makeBoardObject({
      object_id: 'bo-1',
      board_id: 'board-1',
      branch_id: 'b-1',
      zone_id: 'zone-a',
    });
    const { client, emit } = makeMockClient({ 'board-objects': [boardObject] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    act(() =>
      emit('board-objects', 'patched', {
        ...boardObject,
        board_id: 'board-2',
        branch_id: 'b-2',
        zone_id: 'zone-b',
      })
    );

    expect(agorStore.getState().boardObjectsByBoardId.has('board-1')).toBe(false);
    expect(
      agorStore
        .getState()
        .boardObjectsByBoardId.get('board-2')
        ?.map((bo) => bo.object_id)
    ).toEqual(['bo-1']);
    expect(agorStore.getState().boardObjectByBranchId.has('b-1')).toBe(false);
    expect(agorStore.getState().boardObjectByBranchId.get('b-2')?.zone_id).toBe('zone-b');

    act(() => emit('board-objects', 'removed', { ...boardObject, board_id: 'board-2' }));

    expect(agorStore.getState().boardObjectById.has('bo-1')).toBe(false);
    expect(agorStore.getState().boardObjectsByBoardId.has('board-2')).toBe(false);
    expect(agorStore.getState().boardObjectByBranchId.has('b-2')).toBe(false);
  });

  it('keeps unrelated board-object buckets reference-stable on other-board patches', async () => {
    const currentBoardObject = makeBoardObject({ object_id: 'bo-current', board_id: 'board-1' });
    const otherBoardObject = makeBoardObject({
      object_id: 'bo-other',
      board_id: 'board-2',
      branch_id: 'b-2',
    });
    const { client, emit } = makeMockClient({
      'board-objects': [currentBoardObject, otherBoardObject],
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeCurrentBoardBucket = agorStore.getState().boardObjectsByBoardId.get('board-1');

    act(() =>
      emit('board-objects', 'patched', {
        ...otherBoardObject,
        zone_id: 'zone-on-other-board',
      })
    );

    expect(agorStore.getState().boardObjectsByBoardId.get('board-1')).toBe(
      beforeCurrentBoardBucket
    );
    expect(agorStore.getState().boardObjectsByBoardId.get('board-2')?.[0]?.zone_id).toBe(
      'zone-on-other-board'
    );
  });
});

/**
 * Background hydration uses a "skip-apply-on-race" rule (see `runHydration` /
 * `liveRevisionsRef` in useAgorData.ts): the full-set snapshot is applied
 * WHOLESALE only when no live write to the target collection raced the fetch.
 * If one did, the snapshot is discarded and refetched — never overlaid — and a
 * persistent race triggers repeated discard+refetch with capped exponential
 * backoff until a quiet window allows a wholesale apply: the apply is deferred,
 * never permanently skipped. These tests pin that contract (apply-on-quiet,
 * retry-until-quiet, no-resurrect, and per-collection independence) using
 * `onFetch` to land a live write mid-fetch.
 *
 * jsdom's pathname is `/`, so no board scope resolves: only the sessions+branches
 * (and the always-on mcp/gateway/artifact/oauth) hydrations run, while the gated
 * sessions fetch uses `find` and branches resolve to `[]` — so `sessions.findAll`
 * / `branches.findAll` are hit ONLY by the hydration, making call counts exact.
 */
describe('useAgorData — skip-apply-on-race hydration', () => {
  it('applies the full snapshot wholesale when no live write races (apply-on-quiet)', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const b1 = makeBranch({ branch_id: 'b-1' });
    const { client } = makeMockClient({
      // Gated first paint sees only the recent slice; hydration sees the full set.
      'sessions:find': [s1],
      'sessions:findAll': [s1, s2],
      'branches:findAll': [b1],
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
    // s-2 was absent from first paint and only arrives via the hydration.
    expect(agorStore.getState().sessionById.has('s-2')).toBe(true);
    expect(agorStore.getState().branchById.has('b-1')).toBe(true);
    expect(
      agorStore
        .getState()
        .sessionsByBranch.get('b-1')
        ?.map((s) => s.session_id)
        .sort()
    ).toEqual(['s-1', 's-2']);
  });

  it('discards a racy snapshot, refetches, and applies the fresh one without clobbering the live write', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const s3 = makeSession({ session_id: 's-3', branch_id: 'b-1' });
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      'sessions:find': [s1],
      // Once the race settles, the backend's full set already includes the
      // racing create (s-3) — models a real refetch reflecting the new row.
      'sessions:findAll': [s1, s2, s3],
      'branches:findAll': [],
    });
    // A session is created mid-flight on the FIRST hydration fetch only.
    onFetch('sessions', 'findAll', (call) => {
      if (call === 1) emit('sessions', 'created', s3);
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    // The first snapshot was discarded (it raced) and a second fetch applied.
    expect(fetchCount('sessions', 'findAll')).toBe(2);
    // The racing live create survived AND the hydration filled in s-2.
    expect(agorStore.getState().sessionById.has('s-3')).toBe(true);
    expect(agorStore.getState().sessionById.has('s-2')).toBe(true);
  });

  it('retries after races until a quiet window, then applies the fresh snapshot (never gives up)', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      'sessions:find': [s1],
      'sessions:findAll': [s1, s2],
      'branches:findAll': [],
    });
    // Race the first two fetches, then go quiet — the third (immediate) retry
    // sees a clean window and applies. The OLD code would have started skipping
    // toward a permanent give-up; the new loop converges.
    onFetch('sessions', 'findAll', (call) => {
      if (call <= 2) emit('sessions', 'patched', { ...s1, status: `v${call}` });
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    await waitFor(() => expect(agorStore.getState().sessionById.has('s-2')).toBe(true), {
      timeout: 4000,
    });
    // Applied on the first quiet window (3rd attempt) — not skipped forever.
    expect(fetchCount('sessions', 'findAll')).toBe(3);
  });

  it('keeps retrying past the old bounded cap without resurrecting a removed session (never skips)', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      'sessions:find': [s1, s2],
      // Stale backend snapshot ALWAYS still contains s-2: if it were ever applied
      // it would resurrect the removed session.
      'sessions:findAll': [s1, s2],
      'branches:findAll': [],
    });
    onFetch('sessions', 'findAll', (call) => {
      // Remove s-2 during the first fetch, then bump the sessions revision on
      // every subsequent attempt so the hydration never sees a quiet window.
      if (call === 1) emit('sessions', 'removed', s2);
      else emit('sessions', 'patched', { ...s1, status: `v${call}` });
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    // The OLD code stopped after 6 fetches and skipped forever. The new loop
    // never gives up — it keeps re-fetching past that cap (proving "retry until
    // quiet", not "skip after N").
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBeGreaterThanOrEqual(7), {
      timeout: 5000,
    });

    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
    // The stale snapshot was never applied (it never went quiet), so s-2 stays
    // removed — a racy snapshot is never force-applied.
    expect(agorStore.getState().sessionById.has('s-2')).toBe(false);
  });

  it('applies an unrelated collection while another keeps racing (per-collection revisions)', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const m1 = { mcp_server_id: 'm-1', name: 'one' };
    const m2 = { mcp_server_id: 'm-2', name: 'two' };
    const { client, emit, onFetch } = makeMockClient({
      'sessions:find': [s1],
      'sessions:findAll': [s1, s2],
      'branches:findAll': [],
      'mcp-servers': [m1, m2],
    });
    // Keep the SESSIONS hydration perpetually racing (bumps only `sessions`)…
    onFetch('sessions', 'findAll', (call) =>
      emit('sessions', 'patched', { ...s1, status: `v${call}` })
    );
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    // …the mcp-servers hydration is independent of `sessions`, so it applied.
    await waitFor(() => expect(agorStore.getState().mcpServerById.has('m-1')).toBe(true));
    expect(agorStore.getState().mcpServerById.has('m-2')).toBe(true);
    // …while the still-racing sessions hydration has not applied (s-2 absent).
    expect(agorStore.getState().sessionById.has('s-2')).toBe(false);
  });

  it('decouples per-collection hydration: session churn does not block the branch apply', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const b1 = makeBranch({ branch_id: 'b-1' });
    const { client, emit, onFetch } = makeMockClient({
      'sessions:find': [s1],
      'sessions:findAll': [s1, s2],
      // Branches are filled ONLY by hydration on Home (the first-paint heavy
      // batch resolves to [] with no board scope), so this proves the branch
      // apply does not wait on the sessions quiet window.
      'branches:findAll': [b1],
    });
    // Sessions race forever; branches never race.
    onFetch('sessions', 'findAll', (call) =>
      emit('sessions', 'patched', { ...s1, status: `v${call}` })
    );
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    // Branches hydrated on their own quiet window despite perpetual session churn.
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
    // Sessions still racing → not applied (coupling would have blocked branches).
    expect(agorStore.getState().sessionById.has('s-2')).toBe(false);
  });

  it('runs backoff retries with delays preceding attempts (off-by-one)', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      'sessions:find': [s1],
      'sessions:findAll': [s1, s2],
      'branches:findAll': [],
    });
    // Race the first five fetches — pushing PAST the immediate-retry phase into
    // the backoff phase (attempts 5 & 6 are delayed) — then go quiet. The 6th
    // fetch must still run (its backoff delay PRECEDES it) and apply. If the
    // off-by-one delayed-after-the-attempt bug were present, the schedule would
    // be wrong; here the delayed attempts run and converge.
    onFetch('sessions', 'findAll', (call) => {
      if (call <= 5) emit('sessions', 'patched', { ...s1, status: `v${call}` });
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    await waitFor(() => expect(agorStore.getState().sessionById.has('s-2')).toBe(true), {
      timeout: 4000,
    });
    expect(fetchCount('sessions', 'findAll')).toBe(6);
  });
});

/**
 * Bulk Map replacements that are NOT a `runHydration` apply — the reconnect
 * resync's wholesale `setMaps`, and the logout reset — MUST bump the
 * per-collection revisions (and, for the reset, the hydration generations) so an
 * in-flight hydration whose snapshot predates them cannot clobber the newer
 * state or repopulate the Maps after teardown. These tests pin BLOCKING-1.
 */
describe('useAgorData — bulk-write revision bumps', () => {
  it('preserves realtime pinned branch links when the cold Home load skips the links snapshot', async () => {
    const realtimePinnedLink = makeLink({ link_id: 'l-realtime', branch_id: 'b-live' });
    const linksHydrationGate = deferred();
    const { client, emit, onFetch } = makeMockClient({
      'sessions:find': [],
      'sessions:findAll': [],
      'branches:findAll': [],
      'links:findAll': [],
    });

    // Hold the later global links hydration so this test isolates the first-paint
    // skipped-snapshot path instead of racing the background reconciliation.
    onFetch('links', 'findAll', () => linksHydrationGate.promise);
    onFetch('sessions', 'find', (call) => {
      if (call === 1) emit('links', 'created', realtimePinnedLink);
    });

    const { result } = renderHook(() => useAgorData(client));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.initialLoadComplete).toBe(true);
    });

    expect(agorStore.getState().linkById.get('l-realtime')).toBe(realtimePinnedLink);
    expect(agorStore.getState().linksByBranch.get('b-live')).toEqual([realtimePinnedLink]);
  });

  it('silent reconnect removes stale archived-branch pinned links without dropping other link scopes', async () => {
    const branch = makeBranch({ branch_id: 'b-1' });
    const pinnedLink = makeLink({ link_id: 'l-pinned' });
    const unpinnedBranchLink = makeLink({
      link_id: 'l-unpinned',
      is_pinned: false,
      url: 'https://example.com/unpinned',
      target_key: 'url:https://example.com/unpinned',
    });
    const sessionLink = makeLink({
      link_id: 'l-session',
      branch_id: null,
      session_id: 's-1',
      url: 'https://example.com/session',
      target_key: 'url:https://example.com/session',
    });
    const seed: Record<string, unknown[]> = {
      'links:findAll': [pinnedLink],
      'sessions:findAll': [],
      'branches:findAll': [branch],
    };
    const { client, emit, emitIo } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    await waitFor(() => expect(agorStore.getState().linkById.get('l-pinned')).toBe(pinnedLink));
    await waitFor(() => expect(agorStore.getState().branchById.get('b-1')).toBe(branch));

    act(() => {
      emit('links', 'created', unpinnedBranchLink);
      emit('links', 'created', sessionLink);
    });
    expect(agorStore.getState().linkById.get('l-unpinned')).toBe(unpinnedBranchLink);
    expect(agorStore.getState().linkById.get('l-session')).toBe(sessionLink);

    // The archive event was missed. On reconnect, active branch hydration drops
    // the archived branch and the global pinned branch link snapshot no longer
    // contains its link.
    seed['links:findAll'] = [];
    seed['branches:findAll'] = [];
    await act(async () => {
      emitIo('connect');
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(agorStore.getState().linkById.has('l-pinned')).toBe(false));
    expect(agorStore.getState().branchById.has('b-1')).toBe(false);
    expect(agorStore.getState().linkById.get('l-unpinned')).toBe(unpinnedBranchLink);
    expect(agorStore.getState().linkById.get('l-session')).toBe(sessionLink);
    expect(agorStore.getState().linksByBranch.get('b-1')).toEqual([unpinnedBranchLink]);
    expect(agorStore.getState().linksBySession.get('s-1')).toEqual([sessionLink]);
  });

  it('reconnect bulk-replace bumps revisions so an in-flight hydration discards (no clobber)', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const sNew = makeSession({ session_id: 's-new', branch_id: 'b-1' });
    // Initial hydration sees only the stale set (no s-new); the reconnect sees
    // the newer set after we swap the seed reference.
    const seed: Record<string, unknown[]> = {
      'sessions:find': [s1],
      'sessions:findAll': [s1],
      'branches:findAll': [],
    };
    const gate = deferred();
    const { client, onFetch, fetchCount, emitIo } = makeMockClient(seed);
    // Defer the FIRST sessions hydration fetch so it's still in-flight when the
    // reconnect lands.
    onFetch('sessions', 'findAll', (call) => (call === 1 ? gate.promise : undefined));

    const { result } = renderHook(() => useAgorData(client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBe(1));

    // Reconnect delivers the NEWER full set: swap the seed so the reconnect's
    // findAll (call 2) returns it (call 1 already captured the stale reference).
    seed['sessions:findAll'] = [s1, sNew];
    seed['sessions:find'] = [s1, sNew];
    await act(async () => {
      emitIo('connect');
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    // Reconnect applied the newer snapshot and bumped revisions.
    expect(agorStore.getState().sessionById.has('s-new')).toBe(true);

    // Release the stale in-flight hydration. Its snapshot ([s-1] only) would, if
    // applied, drop s-new — but the reconnect's revision bump fails its quiet
    // check, so it discards and re-fetches (now also returning s-new).
    await act(async () => {
      gate.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await flush();
    expect(agorStore.getState().sessionById.has('s-new')).toBe(true);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
  });

  it('logout reset bumps generation/revisions so an in-flight hydration cannot repopulate after logout', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const seed: Record<string, unknown[]> = {
      'sessions:find': [s1],
      'sessions:findAll': [s1],
      'branches:findAll': [],
    };
    const gate = deferred();
    const { client, onFetch, fetchCount } = makeMockClient(seed);
    onFetch('sessions', 'findAll', (call) => (call === 1 ? gate.promise : undefined));

    const { result, rerender } = renderHook(
      ({ c }: { c: Parameters<typeof useAgorData>[0] }) => useAgorData(c),
      { initialProps: { c: client as Parameters<typeof useAgorData>[0] } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBe(1));

    // Logout: client → null fires the reset (clears Maps, cancels hydrations).
    await act(async () => {
      rerender({ c: null });
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    expect(agorStore.getState().sessionById.size).toBe(0);

    // Release the in-flight hydration. Its snapshot ([s-1]) must NOT repopulate
    // the cleared Maps: the reset bumped the generation (cancels the loop) and
    // the revision (fails the quiet check).
    await act(async () => {
      gate.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await flush();
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
  });
});

/**
 * The gated boards list is LEAN (no `data.objects` / `custom_css`) so a workspace
 * load doesn't ship every board's annotations to paint one board's. The displayed
 * board's full record is fetched via `boards.get`, and every board's annotations
 * backfill via the `boards` background hydration. The mock can't see the `lean`
 * query flag, so these tests drive per-call data through the `onFetch` side effect
 * (which runs before each `findAll` reads `seed`).
 */
describe('useAgorData — lean boards list + objects hydration', () => {
  it('paints the displayed board objects from the targeted get at first paint (before boards hydration lands)', async () => {
    window.history.pushState({}, '', '/b/displayed/');
    const leanBoard = { board_id: 'board-D', slug: 'displayed', name: 'Displayed' };
    const fullBoard = {
      ...leanBoard,
      custom_css: '.x{}',
      objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1, height: 1 } },
    };
    const seed: Record<string, unknown[]> = {};
    const gate = deferred();
    const { client, onFetch } = makeMockClient(seed);
    // Gated list (call 1) returns the lean board; hold the boards hydration
    // (call 2) open so the assertion sees the first-paint state — objects can
    // only have come from the targeted `boards.get`, never the hydration.
    seed['boards:get'] = fullBoard as never;
    onFetch('boards', 'findAll', (call) => {
      if (call === 1) {
        seed['boards:findAll'] = [leanBoard];
        return undefined;
      }
      return gate.promise;
    });
    const { result } = renderHook(() => useAgorData(client));
    try {
      await waitForInitialLoad(result);
      const board = agorStore.getState().boardById.get('board-D');
      expect(board?.objects).toBeDefined();
      expect(Object.keys(board?.objects ?? {})).toContain('zone-1');
      expect(board?.custom_css).toBe('.x{}');
    } finally {
      gate.resolve();
      window.history.pushState({}, '', '/');
    }
  });

  it('resolves the board scope for a /m/comments cold deep-link so the displayed board carries its objects at first paint', async () => {
    // The mobile comments route lives outside the main entity route table; a
    // cold deep-link must still resolve its board scope and fire the targeted
    // full-board get, else `board.objects` is undefined until hydration lands.
    // The route carries a full board_id (a UUID), resolved via the short-id
    // resolver — so use a hex id here, not the slug.
    const boardId = '0b0a4d00-0000-7000-8000-0000000000d1';
    window.history.pushState({}, '', `/m/comments/${boardId}`);
    const leanBoard = { board_id: boardId, slug: 'displayed', name: 'Displayed' };
    const fullBoard = {
      ...leanBoard,
      custom_css: '.x{}',
      objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1, height: 1 } },
    };
    const seed: Record<string, unknown[]> = {};
    const gate = deferred();
    const { client, onFetch } = makeMockClient(seed);
    // Hold the boards hydration (call 2) open so the assertion sees first-paint
    // state — objects can only have come from the targeted `boards.get`.
    seed['boards:get'] = fullBoard as never;
    onFetch('boards', 'findAll', (call) => {
      if (call === 1) {
        seed['boards:findAll'] = [leanBoard];
        return undefined;
      }
      return gate.promise;
    });
    const { result } = renderHook(() => useAgorData(client));
    try {
      await waitForInitialLoad(result);
      const board = agorStore.getState().boardById.get(boardId);
      expect(board?.objects).toBeDefined();
      expect(Object.keys(board?.objects ?? {})).toContain('zone-1');
      expect(board?.custom_css).toBe('.x{}');
    } finally {
      gate.resolve();
      window.history.pushState({}, '', '/');
    }
  });

  it('backfills every board objects via the boards background hydration', async () => {
    const leanA = { board_id: 'board-A', slug: 'a', name: 'A' };
    const leanB = { board_id: 'board-B', slug: 'b', name: 'B' };
    const fullA = {
      ...leanA,
      objects: { 'z-a': { type: 'zone', x: 0, y: 0, width: 1, height: 1 } },
    };
    const fullB = {
      ...leanB,
      objects: { 'z-b': { type: 'zone', x: 0, y: 0, width: 1, height: 1 } },
    };
    const seed: Record<string, unknown[]> = {};
    const { client, onFetch } = makeMockClient(seed);
    // Home path (jsdom `/`): no board scope, no targeted get. The lean gated
    // fetch (call 1) carries no objects; the hydration (call 2) carries them.
    onFetch('boards', 'findAll', (call) => {
      seed['boards:findAll'] = call === 1 ? [leanA, leanB] : [fullA, fullB];
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();
    expect(agorStore.getState().boardById.get('board-A')?.objects).toBeDefined();
    expect(agorStore.getState().boardById.get('board-B')?.objects).toBeDefined();
  });
});
