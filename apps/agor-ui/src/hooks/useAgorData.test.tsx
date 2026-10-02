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
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { getRevision } from '../store/agorHydration';
import { agorStore } from '../store/agorStore';
import { markBoardPartitionLoaded, registerDisplayedBoard } from '../store/boardPartitions';
import { captureLoadLifetime } from '../store/loadLifetime';
// Session `patched`/`updated` writes are coalesced to one flush per frame (see
// realtimeBatch); flush synchronously in tests that assert the post-patch store.
import { flushRealtimeNow } from '../store/realtimeBatch';
import { loadSessionMcpServerIds } from '../store/sessionMcpLinks';
import { useAgorData } from './useAgorData';
import { useBoardPartition } from './useBoardPartition';

// The opened-transcript prefetch retains a real reactive session; the mock
// client doesn't model one. Default: ready at once (no deferral). Tests below
// drive `ready` explicitly to pin the ordering.
const transcriptPrefetch = vi.hoisted(() => ({
  prefetchOpenedTranscript: vi.fn(() => ({ ready: Promise.resolve(), release: vi.fn() })),
}));
vi.mock('../store/openedTranscriptPrefetch', () => transcriptPrefetch);

const STANDALONE_AUTHORITY_SCOPE = '__standalone__:__standalone__:0';

/**
 * Minimal AgorClient stand-in. Implements just enough of the service /
 * socket surface the hook touches:
 *   - `service(name).findAll({...})` — initial fetch, returns the
 *     pre-seeded list for that service (default empty).
 *   - `service(name).on/removeListener` — wires up event handlers we
 *     dispatch from tests via `emit(name, event, payload)`.
 *   - `service(name).get(id)` — targeted deep-link / displayed-board reads,
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
  const fetchArguments = new Map<string, unknown[]>();

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

  const recordAndRespond = (name: string, method: 'findAll' | 'find', args: unknown) => {
    const key = `${name}:${method}`;
    fetchArguments.set(key, [...(fetchArguments.get(key) ?? []), args]);
    return respond(name, method);
  };

  const service = (name: string) => ({
    findAll: vi.fn((args) => recordAndRespond(name, 'findAll', args)),
    find: vi.fn((args) => recordAndRespond(name, 'find', args)),
    get: vi.fn((id: unknown) => {
      const key = `${name}:get`;
      fetchCounts.set(key, (fetchCounts.get(key) ?? 0) + 1);
      fetchArguments.set(key, [...(fetchArguments.get(key) ?? []), id]);
      const gate = fetchHooks.get(key)?.(fetchCounts.get(key)!);
      return Promise.resolve(gate).then(() => seed[key] ?? null);
    }),
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
    listeners: (svc: string, event: string) => [...(serviceListeners.get(svc)?.get(event) ?? [])],
    // Fire an `io` event (e.g. `connect`) so tests can drive the reconnect
    // refetch path.
    emitIo: (event: string, payload?: unknown) => {
      for (const fn of ioListeners.get(event) ?? []) fn(payload);
    },
    // Register a synchronous side effect that runs every time `service(name)`'s
    // `method` is invoked (receives the 1-based call count). The hook fires
    // BEFORE the returned promise resolves, so emitting a live event here lands
    // a write DURING the fetch window — exactly the race the hydration guards.
    onFetch: (name: string, method: 'findAll' | 'find' | 'get', fn: (call: number) => unknown) =>
      fetchHooks.set(`${name}:${method}`, fn),
    fetchCount: (name: string, method: 'findAll' | 'find' | 'get') =>
      fetchCounts.get(`${name}:${method}`) ?? 0,
    fetchArguments: (name: string, method: 'findAll' | 'find' | 'get') =>
      fetchArguments.get(`${name}:${method}`) ?? [],
  };
}

/**
 * Put the hook on board `board-1`'s route: board objects and cards load only
 * with a board's partition (never on Home), here at first paint.
 */
function onBoardRoute(seed: Record<string, unknown[]>) {
  const board = { board_id: 'board-1', slug: 'board-one', name: 'Board one' };
  seed.boards ??= [board];
  seed['boards:get'] ??= board as never;
  window.history.pushState({}, '', '/b/board-one/');
  onTestFinished(() => window.history.pushState({}, '', '/'));
  return seed;
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

it('does not resurrect deletion from an in-flight OAuth realtime refetch', async () => {
  const { client, emit, emitIo, onFetch, fetchCount } = makeMockClient({
    'mcp-servers:get': { mcp_server_id: 'server-1', name: 'stale' } as never,
    'mcp-servers/oauth-status': { authenticated_server_ids: ['server-1'] } as never,
  });
  const { result, unmount } = renderHook(() => useAgorData(client));
  try {
    await waitForInitialLoad(result);
    const held = deferred();
    onFetch('mcp-servers', 'get', () => held.promise);
    act(() => emitIo('oauth:completed', { success: true, mcp_server_id: 'server-1' }));
    await waitFor(() => expect(fetchCount('mcp-servers', 'get')).toBe(1));
    act(() => emit('mcp-servers', 'removed', { mcp_server_id: 'server-1' }));
    held.resolve();
    await flush();
    expect(agorStore.getState().mcpServerById.has('server-1')).toBe(false);
    expect(agorStore.getState().userAuthenticatedMcpServerIds.has('server-1')).toBe(false);
  } finally {
    unmount();
  }
});
it('drops an OAuth status answer that lands after unmount, even in the next mount', async () => {
  const userA = makeMockClient({
    'mcp-servers/oauth-status': { authenticated_server_ids: ['server-a'] } as never,
  });
  const held = deferred();
  userA.onFetch('mcp-servers/oauth-status', 'find', () => held.promise);
  const first = renderHook(() => useAgorData(userA.client));
  await waitFor(() => expect(userA.fetchCount('mcp-servers/oauth-status', 'find')).toBe(1));
  first.unmount();

  const userB = makeMockClient({
    'mcp-servers/oauth-status': { authenticated_server_ids: [] } as never,
  });
  const second = renderHook(() => useAgorData(userB.client));
  try {
    await waitForInitialLoad(second.result);
    held.resolve();
    await flush();
    expect(agorStore.getState().userAuthenticatedMcpServerIds.has('server-a')).toBe(false);
  } finally {
    second.unmount();
  }
});
it('does not rescan OAuth grants on an idle 60-second timer', async () => {
  const { client, fetchCount } = makeMockClient();
  const { result, unmount } = renderHook(() => useAgorData(client));
  try {
    await waitForInitialLoad(result);
    await waitFor(() => expect(fetchCount('mcp-servers/oauth-status', 'find')).toBeGreaterThan(0));
    const initial = fetchCount('mcp-servers/oauth-status', 'find');
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchCount('mcp-servers/oauth-status', 'find')).toBe(initial);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

describe('useAgorData — socket-event bailouts', () => {
  it('scopes the real cold mobile board load before fetching board entities', async () => {
    const boardId = '01a012d8-1b9b-7909-b6f4-2024dfc7c51e';
    const { client, fetchArguments } = makeMockClient({
      boards: [{ board_id: boardId, slug: 'delivery' }],
      'board-objects': [makeBoardObject({ board_id: boardId })],
    });
    window.history.pushState({}, '', `/m/board/${boardId}`);

    const { result } = renderHook(() => useAgorData(client));
    try {
      await waitForInitialLoad(result);

      for (const service of ['branches', 'sessions', 'board-objects', 'cards']) {
        expect(fetchArguments(service, 'findAll')).toContainEqual({
          query: expect.objectContaining({ board_id: boardId }),
        });
      }
      // Comments are global on every route (design r3 §2), never board-scoped.
      expect(fetchArguments('board-comments', 'findAll')).toEqual([{ query: { $limit: 10000 } }]);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('opens a cold mobile session without waiting for a stalled branch get', async () => {
    const boardId = '01a012d8-1b9b-7909-b6f4-2024dfc7c51e';
    const sessionId = '01a012d8-4f50-7c32-9daa-6e3f70819b2c';
    const branchId = '01a012d8-3e4f-7b21-8c99-5d2e6f708a1b';
    const directSession = makeSession({
      session_id: sessionId,
      branch_id: branchId,
      branch_board_id: boardId,
    });
    const directBranch = makeBranch({ branch_id: branchId, board_id: boardId });
    const boardObject = makeBoardObject({ board_id: boardId, branch_id: branchId });
    const { client, fetchArguments, fetchCount, onFetch } = makeMockClient({
      sessions: [],
      boards: [{ board_id: boardId, slug: 'delivery' }],
      branches: [directBranch],
      'sessions:get': directSession,
      'branches:get': directBranch,
      'board-objects': [boardObject],
    });
    onFetch('branches', 'get', () => new Promise(() => {}));
    window.history.pushState({}, '', `/m/session/${sessionId}`);

    const { result } = renderHook(() => useAgorData(client, { directSessionId: sessionId }));
    await waitForInitialLoad(result);

    expect(agorStore.getState().sessionById.get(sessionId)).toMatchObject({ branch_id: branchId });
    expect(fetchCount('branches', 'get')).toBe(0);
    expect(agorStore.getState().branchById.get(branchId)).toMatchObject({ board_id: boardId });
    expect(agorStore.getState().boardObjectById.get('bo-1')).toMatchObject({ board_id: boardId });
    expect(fetchArguments('board-objects', 'findAll')).toContainEqual({
      query: expect.objectContaining({ board_id: boardId }),
    });
    window.history.pushState({}, '', '/');
  });

  it('opens a legacy session without board metadata or granting access to its missing branch', async () => {
    const session = makeSession({ session_id: 'legacy-session', branch_id: 'hidden-branch' });
    const { client, onFetch, fetchCount } = makeMockClient({
      sessions: [],
      branches: [],
      'sessions:get': session,
    });
    onFetch('branches', 'get', () => new Promise(() => {}));
    const { result } = renderHook(() => useAgorData(client, { directSessionId: 'legacy-session' }));
    await waitForInitialLoad(result);
    expect(agorStore.getState().sessionById.has('legacy-session')).toBe(true);
    expect(agorStore.getState().branchById.has('hidden-branch')).toBe(false);
    expect(fetchCount('branches', 'get')).toBe(0);
  });

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
      flushRealtimeNow(STANDALONE_AUTHORITY_SCOPE);
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
      flushRealtimeNow(STANDALONE_AUTHORITY_SCOPE);
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
    const boardObject = makeBoardObject({ object_id: 'bo-1', branch_id: branch.branch_id });
    const { client, emit } = makeMockClient(
      onBoardRoute({
        branches: [branch],
        sessions: [session],
        'board-objects': [boardObject],
      })
    );
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(agorStore.getState().branchById.has('b-1')).toBe(true);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);

    act(() => emit('branches', 'patched', { ...branch, archived: true }));

    expect(agorStore.getState().branchById.has('b-1')).toBe(false);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(false);
    // Archive preserves placement in the database for unarchive, so unlike a
    // hard delete it must stay in the client indexes too.
    expect(agorStore.getState().boardObjectById.get('bo-1')).toEqual(boardObject);
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
      flushRealtimeNow(STANDALONE_AUTHORITY_SCOPE);
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
    const boardObject = makeBoardObject({ object_id: 'bo-1', branch_id: 'b-1' });
    const duplicateBoardObject = makeBoardObject({
      object_id: 'bo-duplicate',
      board_id: 'board-2',
      branch_id: 'b-1',
    });
    const { client, emit } = makeMockClient(
      onBoardRoute({
        sessions: [session],
        branches: [branch],
        'board-objects': [boardObject, duplicateBoardObject],
      })
    );
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(agorStore.getState().branchById.has('b-1')).toBe(true);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(true);
    expect(agorStore.getState().boardObjectById.has('bo-1')).toBe(true);
    expect(
      agorStore
        .getState()
        .boardObjectsByBoardId.get('board-1')
        ?.some((object) => object.object_id === 'bo-1')
    ).toBe(true);
    const cascadeRevisions = {
      boardObjects: getRevision('boardObjects'),
      boards: getRevision('boards'),
      comments: getRevision('comments'),
      sessionMcp: getRevision('sessionMcp'),
      gatewayChannels: getRevision('gatewayChannels'),
      artifacts: getRevision('artifacts'),
    };

    act(() => emit('branches', 'removed', branch));

    expect(agorStore.getState().branchById.has('b-1')).toBe(false);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionsByBranch.has('b-1')).toBe(false);
    expect(agorStore.getState().boardObjectById.has('bo-1')).toBe(false);
    expect(agorStore.getState().boardObjectById.has('bo-duplicate')).toBe(false);
    expect(
      agorStore
        .getState()
        .boardObjectsByBoardId.get('board-1')
        ?.some((object) => object.object_id === 'bo-1') ?? false
    ).toBe(false);
    expect(
      agorStore
        .getState()
        .boardObjectsByBoardId.get('board-2')
        ?.some((object) => object.branch_id === 'b-1') ?? false
    ).toBe(false);
    for (const [collection, before] of Object.entries(cascadeRevisions)) {
      expect(getRevision(collection as keyof typeof cascadeRevisions)).toBe(before + 1);
    }
  });

  it('authoritatively clears task/message comment attachments after a branch cascade', async () => {
    const branch = makeBranch({ branch_id: 'b-1' });
    const taskComment = {
      comment_id: 'comment-task',
      board_id: 'board-1',
      task_id: 'task-deleted-with-branch',
      content: 'task comment',
    };
    const messageComment = {
      comment_id: 'comment-message',
      board_id: 'board-1',
      message_id: 'message-deleted-with-branch',
      content: 'message comment',
    };
    const seed: Record<string, unknown[]> = {
      branches: [branch],
      'board-comments': [taskComment, messageComment],
    };
    const { client, emit } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    seed['board-comments:findAll'] = [
      { ...taskComment, task_id: undefined },
      { ...messageComment, message_id: undefined },
    ];
    act(() => emit('branches', 'removed', branch));

    await waitFor(() => {
      expect(agorStore.getState().commentById.get('comment-task')?.task_id).toBeUndefined();
      expect(agorStore.getState().commentById.get('comment-message')?.message_id).toBeUndefined();
    });
  });

  it('keeps a missed hard delete removed after reconnect refetch', async () => {
    // On the board, which the resync reconciles (other boards are unloaded).
    window.history.pushState({}, '', '/b/displayed/');
    const board = { board_id: 'board-1', slug: 'displayed', name: 'Displayed' };
    const session = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const branch = makeBranch({ branch_id: 'b-1' });
    const boardObject = makeBoardObject({ object_id: 'bo-1', branch_id: 'b-1' });
    const seed: Record<string, unknown[]> = {
      boards: [board],
      'boards:get': board as never,
      'sessions:find': [session],
      'sessions:findAll': [session],
      'branches:findAll': [branch],
      'board-objects:findAll': [boardObject],
    };
    const { client, emitIo } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    onTestFinished(() => window.history.pushState({}, '', '/'));
    await waitForInitialLoad(result);

    expect(agorStore.getState().branchById.has('b-1')).toBe(true);
    expect(agorStore.getState().boardObjectById.has('bo-1')).toBe(true);

    seed['sessions:find'] = [];
    seed['sessions:findAll'] = [];
    seed['branches:findAll'] = [];
    seed['board-objects:findAll'] = [];
    act(() => emitIo('connect'));

    await waitFor(() => {
      expect(agorStore.getState().branchById.has('b-1')).toBe(false);
      expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
      expect(agorStore.getState().boardObjectById.has('bo-1')).toBe(false);
    });
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

  it("buckets the displayed board's board objects at first paint", async () => {
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
    const { client } = makeMockClient(
      onBoardRoute({ 'board-objects': [branchObject, cardObject, otherBoardObject] })
    );
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
  });

  it('keeps board-object buckets in sync across patch and remove events', async () => {
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
    expect(agorStore.getState().boardObjectById.get('bo-1')?.zone_id).toBe('zone-b');

    act(() => emit('board-objects', 'removed', { ...boardObject, board_id: 'board-2' }));

    expect(agorStore.getState().boardObjectById.has('bo-1')).toBe(false);
    expect(agorStore.getState().boardObjectsByBoardId.has('board-2')).toBe(false);
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
    const { client, fetchArguments } = makeMockClient({
      // Gated first paint sees only the recent slice; hydration sees the full set.
      'sessions:find': [s1],
      'sessions:findAll': [s1, s2],
      'branches:findAll': [b1],
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    expect(fetchArguments('sessions', 'find')).toContainEqual({
      query: {
        archived: false,
        lean: true,
        $limit: 50,
        $count: false,
        $sort: { updated_at: -1 },
      },
    });
    for (const args of fetchArguments('sessions', 'findAll')) {
      expect((args as { query: Record<string, unknown> }).query.$count).toBeUndefined();
      // Store-feeding session lists never carry the bulky single-session context.
      expect((args as { query: Record<string, unknown> }).query.lean).toBe(true);
    }

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
    const { client, fetchCount, onFetch } = makeMockClient(seed);
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
      expect(fetchCount('boards', 'get')).toBe(1);
      expect(fetchCount('branches', 'get')).toBe(0);
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
    const { client, fetchCount, onFetch } = makeMockClient(seed);
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
      expect(fetchCount('boards', 'get')).toBe(1);
      expect(fetchCount('branches', 'get')).toBe(0);
      expect(board?.custom_css).toBe('.x{}');
    } finally {
      gate.resolve();
      window.history.pushState({}, '', '/');
    }
  });

  it("never reads every board's full record: Home has only the lean list", async () => {
    const leanA = { board_id: 'board-A', slug: 'a', name: 'A' };
    const { client, fetchCount, fetchArguments } = makeMockClient({ boards: [leanA] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();
    expect(fetchCount('boards', 'findAll')).toBe(1);
    expect(fetchArguments('boards', 'findAll')[0]).toMatchObject({ query: { lean: true } });
    expect(fetchCount('boards', 'get')).toBe(0);
    expect(fetchCount('board-objects', 'findAll')).toBe(0);
    expect(fetchCount('cards', 'findAll')).toBe(0);
  });

  it('reconnect resync reads the displayed board once and every board list lean', async () => {
    window.history.pushState({}, '', '/b/displayed/');
    const board = {
      board_id: 'board-D',
      slug: 'displayed',
      name: 'Displayed',
      objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1, height: 1 } },
    };
    const seed: Record<string, unknown[]> = {
      boards: [board],
      'boards:get': board as never,
    };
    const { client, emitIo, fetchCount, fetchArguments } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    try {
      await waitForInitialLoad(result);
      await flush();
      expect(fetchCount('boards', 'get')).toBe(1);

      act(() => emitIo('connect'));
      await waitFor(() => expect(fetchCount('boards', 'findAll')).toBe(2));
      await flush();

      // The resync reads the lean list plus ONE point read of the displayed
      // board (never every board's full record), so its zones never flash off.
      // Other boards' records load with their partitions.
      expect(fetchCount('boards', 'get')).toBe(2);
      expect(fetchCount('branches', 'get')).toBe(0);
      for (const read of fetchArguments('boards', 'findAll') as Array<{ query?: unknown }>) {
        expect(read.query).toMatchObject({ lean: true });
      }
      expect(agorStore.getState().boardById.get('board-D')?.objects).toBeDefined();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('useAgorData — user-scope flags', () => {
  it('reset on an identity change and recover once the silent resync re-runs the scope', async () => {
    // Rows honour each user's `created_by` filter (rows violating it would
    // read as an older daemon that ignores the key).
    const seed: Record<string, unknown[]> = {
      'sessions:find': [makeSession({ created_by: 'user-a' })],
      'sessions:findAll': [makeSession({ created_by: 'user-a' })],
      'branches:findAll': [makeBranch({ created_by: 'user-a' })],
    };
    const gate = deferred();
    const { client, onFetch, fetchCount } = makeMockClient(seed);
    const { result, rerender } = renderHook(
      ({ userId, generation }) =>
        useAgorData(client, {
          authenticatedUserId: userId,
          authenticatedUserRole: 'member',
          authGeneration: generation,
          connectionReady: true,
        }),
      { initialProps: { userId: 'user-a', generation: 1 } }
    );
    await waitForInitialLoad(result);
    const scopeLoaded = () => {
      const s = agorStore.getState();
      return [s.mySessionsLoaded, s.homeBranchesLoaded, s.teammatesLoaded];
    };
    await waitFor(() => expect(scopeLoaded()).toEqual([true, true, true]));

    // Hold the resync's full session fetch so the reset flags can be observed first.
    const calls = fetchCount('sessions', 'findAll');
    onFetch('sessions', 'findAll', (call) => (call > calls ? gate.promise : undefined));
    seed['sessions:find'] = [makeSession({ created_by: 'user-b' })];
    seed['sessions:findAll'] = [makeSession({ created_by: 'user-b' })];
    seed['branches:findAll'] = [makeBranch({ created_by: 'user-b' })];
    rerender({ userId: 'user-b', generation: 2 });
    await flush();
    expect(scopeLoaded()).toEqual([false, false, false]);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(scopeLoaded()).toEqual([true, true, true]));
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
  });
});

describe('session MCP links', () => {
  it('reads no session↔MCP links globally, and realtime events still apply to any session', async () => {
    const { client, emit, listeners, fetchCount } = makeMockClient({
      'session-mcp-servers': [{ session_id: 's-1', mcp_server_id: 'old-server' }],
    });
    const { result, unmount } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();
    expect(fetchCount('session-mcp-servers', 'findAll')).toBe(0);
    expect(fetchCount('session-mcp-servers', 'find')).toBe(0);
    expect(agorStore.getState().sessionMcpServerIds.size).toBe(0);

    const patch = { session_id: 's-1', mcp_server_ids: ['selected-server'] };
    act(() => emit('session-mcp-servers', 'patched', patch));
    act(() => emit('session-mcp-servers', 'created', { session_id: 's-2', mcp_server_id: 'x' }));
    expect(agorStore.getState().sessionMcpServerIds.get('s-1')).toEqual(['selected-server']);
    expect(agorStore.getState().sessionMcpServerIds.get('s-2')).toEqual(['x']);
    // Present through events only: not loaded, so not editable.
    expect(agorStore.getState().sessionMcpLoaded.size).toBe(0);

    const before = agorStore.getState().sessionMcpServerIds;
    act(() => emit('session-mcp-servers', 'patched', patch));
    expect(agorStore.getState().sessionMcpServerIds).toBe(before);

    act(() => emit('session-mcp-servers', 'patched', { ...patch, mcp_server_ids: [] }));
    expect(agorStore.getState().sessionMcpServerIds.get('s-1') ?? []).toEqual([]);
    unmount();
    expect(listeners('session-mcp-servers', 'patched')).toHaveLength(0);
  });

  it('a reconnect resync marks every session unloaded, and a read from before it never marks one loaded', async () => {
    const seed = { 'session-mcp-servers': [{ session_id: 's-1', mcp_server_id: 'a' }] };
    const { client, emitIo, onFetch, fetchCount } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    await act(async () => {
      await loadSessionMcpServerIds(client, 's-1');
    });
    expect(agorStore.getState().sessionMcpLoaded.has('s-1')).toBe(true);
    expect(fetchCount('session-mcp-servers', 'find')).toBe(1);

    // A read of s-2 is held across the reconnect.
    const held = deferred();
    onFetch('session-mcp-servers', 'find', (call) => (call === 2 ? held.promise : undefined));
    let staleRead!: Promise<void>;
    act(() => {
      staleRead = loadSessionMcpServerIds(client, 's-2');
    });
    act(() => emitIo('connect'));
    await flush();
    expect(agorStore.getState().sessionMcpLoaded.size).toBe(0);
    await act(async () => {
      held.resolve();
      await staleRead;
    });
    expect(agorStore.getState().sessionMcpLoaded.has('s-2')).toBe(false);
  });

  it.each(['tenant-a-user', 'tenant-b-user'])(
    'rejects previous-auth events and reads after reauthentication as %s',
    async (userId) => {
      const seed = {
        'session-mcp-servers': [{ session_id: 'session-a', mcp_server_id: 'server-a' }],
      };
      const { client, listeners, onFetch } = makeMockClient(seed);
      const held = deferred();
      onFetch('session-mcp-servers', 'find', (call) => (call === 1 ? held.promise : undefined));
      const { result, rerender } = renderHook(
        ({ userId, generation, ready }) =>
          useAgorData(client, {
            authenticatedUserId: userId,
            authenticatedUserRole: 'member',
            authGeneration: generation,
            connectionReady: ready,
          }),
        { initialProps: { userId: 'tenant-a-user', generation: 1, ready: true } }
      );
      await waitForInitialLoad(result);
      let oldRead!: Promise<void>;
      act(() => {
        oldRead = loadSessionMcpServerIds(client, 'session-a');
      });
      const oldListeners = listeners('session-mcp-servers', 'patched');
      expect(oldListeners).toHaveLength(1);
      rerender({ userId, generation: 2, ready: true });
      await act(async () => {
        for (const listener of oldListeners) {
          listener({ session_id: 'session-a', mcp_server_ids: ['server-a'] });
        }
        held.resolve();
        await oldRead;
      });
      expect(agorStore.getState().sessionMcpServerIds.size).toBe(0);
      expect(agorStore.getState().sessionMcpLoaded.size).toBe(0);
    }
  );
});

describe('useAgorData — opened session transcript priority', () => {
  const OPEN_ID = '01a0dc28-31f3-71d9-bee6-d301b0524806';
  const OPEN_SHORT = '01a0dc28';

  function deferredPrefetch() {
    let resolve!: () => void;
    const ready = new Promise<void>((done) => {
      resolve = done;
    });
    const release = vi.fn();
    transcriptPrefetch.prefetchOpenedTranscript.mockReturnValueOnce({ ready, release });
    return { resolve, release };
  }

  it('holds the global hydration until the opened transcript is ready', async () => {
    const session = makeSession({ session_id: OPEN_ID });
    const other = makeSession({ session_id: 's-global-only' });
    const { client, fetchCount } = makeMockClient({
      'sessions:find': [session],
      'sessions:findAll': [session, other],
    });
    const prefetch = deferredPrefetch();

    const { result } = renderHook(() => useAgorData(client, { directSessionId: OPEN_SHORT }));
    await waitForInitialLoad(result);

    expect(transcriptPrefetch.prefetchOpenedTranscript).toHaveBeenLastCalledWith(client, OPEN_ID);
    expect(fetchCount('sessions', 'findAll')).toBe(0);
    expect(fetchCount('branches', 'findAll')).toBe(0);
    expect(fetchCount('boards', 'findAll')).toBe(1); // the gated lean list only
    expect(agorStore.getState().sessionById.has('s-global-only')).toBe(false);

    await act(async () => prefetch.resolve());
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBe(1));
    expect(fetchCount('branches', 'findAll')).toBe(1);
    expect(fetchCount('boards', 'findAll')).toBe(1); // full board records load per board only
    await waitFor(() => expect(agorStore.getState().sessionById.has('s-global-only')).toBe(true));
  });

  it('skips the deferred hydration and releases the prefetch on unmount', async () => {
    const session = makeSession({ session_id: OPEN_ID });
    const { client, fetchCount } = makeMockClient({ 'sessions:find': [session] });
    const prefetch = deferredPrefetch();

    const { result, unmount } = renderHook(() => useAgorData(client, { directSessionId: OPEN_ID }));
    await waitForInitialLoad(result);
    unmount();
    expect(prefetch.release).toHaveBeenCalled();

    await act(async () => prefetch.resolve());
    expect(fetchCount('sessions', 'findAll')).toBe(0);
    expect(fetchCount('branches', 'findAll')).toBe(0);
  });

  it('abandons a load unmounted during the light batch (no prefetch, no maps, no hydration)', async () => {
    transcriptPrefetch.prefetchOpenedTranscript.mockClear();
    const session = makeSession({ session_id: OPEN_ID });
    const { client, fetchCount, onFetch } = makeMockClient({ 'sessions:find': [session] });
    const light = deferred();
    onFetch('sessions', 'find', () => light.promise);

    const { unmount } = renderHook(() => useAgorData(client, { directSessionId: OPEN_ID }));
    await waitFor(() => expect(fetchCount('sessions', 'find')).toBe(1));
    unmount();
    await act(async () => {
      light.resolve();
      await new Promise((done) => setTimeout(done, 100));
      await flush();
    });

    expect(transcriptPrefetch.prefetchOpenedTranscript).not.toHaveBeenCalled();
    expect(fetchCount('cards', 'findAll')).toBe(0); // heavy batch never started
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(fetchCount('sessions', 'findAll')).toBe(0);
    expect(fetchCount('branches', 'findAll')).toBe(0);
  });

  it('abandons a load unmounted during the heavy batch (prefetch released, nothing applied)', async () => {
    transcriptPrefetch.prefetchOpenedTranscript.mockClear();
    const session = makeSession({ session_id: OPEN_ID });
    const { client, fetchCount, onFetch } = makeMockClient({ 'sessions:find': [session] });
    const heavy = deferred();
    // Comments are gated on every route (Home defers cards to the background),
    // so holding them holds the heavy batch.
    onFetch('board-comments', 'findAll', () => heavy.promise);
    const release = vi.fn();
    // `ready` settles at once, so a resumed load would start the global sets.
    transcriptPrefetch.prefetchOpenedTranscript.mockReturnValueOnce({
      ready: Promise.resolve(),
      release,
    });

    const { unmount } = renderHook(() => useAgorData(client, { directSessionId: OPEN_ID }));
    await waitFor(() => expect(fetchCount('board-comments', 'findAll')).toBe(1));
    expect(transcriptPrefetch.prefetchOpenedTranscript).toHaveBeenCalledTimes(1);
    unmount();
    expect(release).toHaveBeenCalled();
    await act(async () => {
      heavy.resolve();
      // Let a resumed load pass its requestAnimationFrame yield and the
      // deferred hydration start.
      await new Promise((done) => setTimeout(done, 100));
      await flush();
    });

    expect(transcriptPrefetch.prefetchOpenedTranscript).toHaveBeenCalledTimes(1);
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(fetchCount('sessions', 'findAll')).toBe(0);
    expect(fetchCount('branches', 'findAll')).toBe(0);
  });

  it('does not prefetch or defer without a session route', async () => {
    transcriptPrefetch.prefetchOpenedTranscript.mockClear();
    const { client, fetchCount } = makeMockClient({ sessions: [makeSession()] });

    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(transcriptPrefetch.prefetchOpenedTranscript).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBe(1));
  });

  it('holds only the bulk U1 read behind the opened transcript', async () => {
    // A full gated page (200 of mine), so the scope needs U1.
    const page = Array.from({ length: 200 }, (_, i) =>
      makeSession({
        session_id: i === 0 ? OPEN_ID : `s-mine-${i}`,
        created_by: 'user-me',
      })
    );
    const { client, fetchArguments } = makeMockClient({ 'sessions:find': page });
    const prefetch = deferredPrefetch();
    const u1Sent = () =>
      fetchArguments('sessions', 'find').some(
        (args) => (args as { query: { $limit?: number } }).query.$limit === 10000
      );

    const { result } = renderHook(() =>
      useAgorData(client, {
        authenticatedUserId: 'user-me',
        authenticatedUserRole: 'member',
        authGeneration: 1,
        connectionReady: true,
        directSessionId: OPEN_SHORT,
      })
    );
    await waitForInitialLoad(result);
    await waitFor(() => expect(agorStore.getState().teammatesLoaded).toBe(true));
    expect(u1Sent()).toBe(false);

    await act(async () => prefetch.resolve());
    await waitFor(() => expect(u1Sent()).toBe(true));
  });

  it('starts the user scope without waiting for the opened transcript', async () => {
    const session = makeSession({ session_id: OPEN_ID, created_by: 'user-me' });
    const { client, fetchArguments, fetchCount } = makeMockClient({ 'sessions:find': [session] });
    const prefetch = deferredPrefetch();

    const { result } = renderHook(() =>
      useAgorData(client, {
        authenticatedUserId: 'user-me',
        authenticatedUserRole: 'member',
        authGeneration: 1,
        connectionReady: true,
        directSessionId: OPEN_SHORT,
      })
    );
    await waitForInitialLoad(result);

    // The global snapshots wait for the transcript; my teammates (U3) do not.
    await waitFor(() =>
      expect(fetchArguments('branches', 'find')).toContainEqual({
        query: { teammate: true, archived: false, $limit: 1000 },
      })
    );
    expect(fetchCount('sessions', 'findAll')).toBe(0);
    await waitFor(() => expect(agorStore.getState().teammatesLoaded).toBe(true));

    await act(async () => prefetch.resolve());
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBe(1));
  });
});

describe('useAgorData — user-scoped first paint (design r3 §3.1)', () => {
  const authority = {
    authenticatedUserId: 'user-me',
    authenticatedUserRole: 'member',
    authGeneration: 1,
    connectionReady: true,
  };
  const never = () => new Promise(() => {});

  it('gates Home on my newest sessions and global comments, and reads no board objects or cards', async () => {
    window.history.pushState({}, '', '/');
    const mine = makeSession({ session_id: 's-mine', created_by: 'user-me' });
    const { client, fetchArguments, onFetch } = makeMockClient({ 'sessions:find': [mine] });
    // Annotations never resolve: Home must still open its gate.
    onFetch('board-objects', 'findAll', never);
    onFetch('cards', 'findAll', never);
    // Hold the global sessions hydration so the first-paint state is observed.
    onFetch('sessions', 'findAll', never);
    const { result } = renderHook(() => useAgorData(client, authority));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.initialLoadComplete).toBe(true);
    });
    // The gated page is MY sessions; it replaces the global recent slice.
    expect(fetchArguments('sessions', 'find')[0]).toEqual({
      query: {
        created_by: 'user-me',
        archived: false,
        $sort: { updated_at: -1 },
        $limit: 200,
        $count: false,
        lean: true,
      },
    });
    expect(agorStore.getState().sessionById.has('s-mine')).toBe(true);
    const gated = result.current.initialLoadItems.map((item) => item.key);
    expect(gated).toContain('board-comments');
    expect(gated).not.toContain('cards');
    expect(gated).not.toContain('board-objects');
    expect(fetchArguments('board-comments', 'findAll')).toEqual([{ query: { $limit: 10000 } }]);
    // Home never reads board objects or cards; a board loads its own.
    await flush();
    expect(fetchArguments('board-objects', 'findAll')).toEqual([]);
    expect(fetchArguments('cards', 'findAll')).toEqual([]);
    // One gated row < 200: the gated page already holds all of my sessions.
    await waitFor(() => expect(agorStore.getState().mySessionsLoaded).toBe(true));
  });

  it('degrades to the global recent slice when an older daemon rejects the my-sessions page', async () => {
    window.history.pushState({}, '', '/');
    const recent = makeSession({ session_id: 's-recent' });
    const { client, fetchArguments, onFetch } = makeMockClient({ 'sessions:find': [recent] });
    // Call 1 is the my-sessions page; call 2 the fallback recent slice.
    onFetch('sessions', 'find', (call) =>
      call === 1 ? Promise.reject(new Error('400 $count unsupported')) : undefined
    );
    onFetch('sessions', 'findAll', never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useAgorData(client, authority));
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.initialLoadComplete).toBe(true);
      });
      expect(result.current.error).toBeNull();
      expect(fetchArguments('sessions', 'find')[1]).toEqual({
        query: {
          archived: false,
          lean: true,
          $limit: 50,
          $count: false,
          $sort: { updated_at: -1 },
        },
      });
      expect(agorStore.getState().sessionById.has('s-recent')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a session created during first paint and never skips U1 on that raced page', async () => {
    window.history.pushState({}, '', '/');
    const gated = makeSession({ session_id: 's-old', created_by: 'user-me' });
    const { client, emit, onFetch, fetchArguments } = makeMockClient({
      'sessions:find': [gated],
    });
    const comments = deferred();
    onFetch('board-comments', 'findAll', (call) => (call === 1 ? comments.promise : undefined));
    onFetch('sessions', 'findAll', never);
    const { result } = renderHook(() => useAgorData(client, authority));
    await waitFor(() => expect(fetchArguments('board-comments', 'findAll')).toHaveLength(1));

    // My new session arrives live while the gated comments are still pending,
    // and someone removes a session the gated page still holds.
    const created = makeSession({ session_id: 's-new', created_by: 'user-me' });
    act(() => emit('sessions', 'created', created));
    await act(async () => {
      comments.resolve();
      await comments.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const state = agorStore.getState();
    expect(state.sessionById.get('s-new')).toBe(created);
    expect(
      state.sessionsByBranch
        .get('b-1')
        ?.map((s) => s.session_id)
        .sort()
    ).toEqual(['s-new', 's-old']);
    // One gated row < 200, but the page raced a create of mine: U1 still runs.
    await waitFor(() =>
      expect(
        fetchArguments('sessions', 'find').some(
          (args) => (args as { query: { $limit?: number } }).query.$limit === 10000
        )
      ).toBe(true)
    );
  });

  it('keeps a live removal and a live comment over the first-paint snapshot', async () => {
    window.history.pushState({}, '', '/');
    const doomed = makeSession({ session_id: 's-doomed', created_by: 'user-me' });
    const seed: Record<string, unknown[]> = { 'sessions:find': [doomed], 'board-comments': [] };
    const { client, emit, onFetch } = makeMockClient(seed);
    const comments = deferred();
    onFetch('board-comments', 'findAll', (call) => (call === 1 ? comments.promise : undefined));
    onFetch('sessions', 'findAll', never);
    const { result } = renderHook(() => useAgorData(client, authority));
    await waitFor(() => expect(result.current.initialLoadItems.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const comment = { comment_id: 'c-live', board_id: 'board-1', content: 'hi' };
    // The server no longer has it either (the raced page makes U1 read again).
    seed['sessions:find'] = [];
    act(() => {
      emit('sessions', 'removed', doomed);
      emit('board-comments', 'created', comment);
    });
    await act(async () => {
      comments.resolve();
      await comments.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(agorStore.getState().sessionById.has('s-doomed')).toBe(false);
    expect(agorStore.getState().commentById.has('c-live')).toBe(true);
  });

  it('sends the id reads for branches only U1 references before the global snapshots', async () => {
    window.history.pushState({}, '', '/');
    // A full gated page (200 of mine) on b-1, so the scope runs U1. U1 also
    // returns an older session on b-old: no gated row, U2 or U3 knows it.
    const page = Array.from({ length: 200 }, (_, i) =>
      makeSession({ session_id: `s-${i}`, created_by: 'user-me', branch_id: 'b-1' })
    );
    const older = makeSession({ session_id: 's-older', created_by: 'user-me', branch_id: 'b-old' });
    const seed: Record<string, unknown[]> = { 'sessions:find': page };
    const mock = makeMockClient(seed);
    // Call 2 of sessions.find is U1 (call 1 is the gated page).
    mock.onFetch('sessions', 'find', (call) => {
      if (call === 2) seed['sessions:find'] = [...page, older];
      return undefined;
    });
    const order: string[] = [];
    const service = mock.client.service;
    (mock.client as { service: unknown }).service = (name: string) => {
      const svc = service(name);
      for (const method of ['find', 'findAll'] as const) {
        const original = svc[method];
        svc[method] = vi.fn((args?: { query?: Record<string, unknown> }) => {
          const ids = (args?.query?.branch_id as { $in?: string[] } | undefined)?.$in;
          order.push(ids ? `ids:${ids.join(',')}` : `${name}:${method}`);
          return original(args);
        });
      }
      return svc;
    };
    const { result } = renderHook(() => useAgorData(mock.client, authority));
    await waitForInitialLoad(result);
    await waitFor(() => expect(order).toContain('sessions:findAll'));
    const u1OnlyRead = order.findIndex(
      (entry) => entry.startsWith('ids:') && entry.includes('b-old')
    );
    expect(u1OnlyRead).toBeGreaterThanOrEqual(0);
    expect(u1OnlyRead).toBeLessThan(order.indexOf('sessions:findAll'));
    expect(u1OnlyRead).toBeLessThan(order.lastIndexOf('branches:findAll'));
    await waitFor(() => expect(agorStore.getState().homeBranchesLoaded).toBe(true));
  });

  it('sends the U1-only id reads before the global snapshots even when my branches fail', async () => {
    window.history.pushState({}, '', '/');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = Array.from({ length: 200 }, (_, i) =>
      makeSession({ session_id: `s-${i}`, created_by: 'user-me', branch_id: 'b-1' })
    );
    const older = makeSession({ session_id: 's-older', created_by: 'user-me', branch_id: 'b-old' });
    // The global session snapshot holds every session too, as the daemon's would.
    const seed: Record<string, unknown[]> = {
      'sessions:find': page,
      'sessions:findAll': [...page, older],
    };
    const mock = makeMockClient(seed);
    mock.onFetch('sessions', 'find', (call) => {
      if (call === 2) seed['sessions:find'] = [...page, older];
      return undefined;
    });
    // Hold the global branch snapshot so its compatibility pass can't settle
    // b-old first; the order of the requests is what's under test.
    let releaseGlobalBranches!: () => void;
    const globalBranches = new Promise<void>((resolve) => {
      releaseGlobalBranches = resolve;
    });
    mock.onFetch('branches', 'findAll', () => globalBranches);
    const order: string[] = [];
    const service = mock.client.service;
    (mock.client as { service: unknown }).service = (name: string) => {
      const svc = service(name);
      for (const method of ['find', 'findAll'] as const) {
        const original = svc[method];
        svc[method] = vi.fn((args?: { query?: Record<string, unknown> }) => {
          const ids = (args?.query?.branch_id as { $in?: string[] } | undefined)?.$in;
          if (name === 'branches' && args?.query?.created_by) {
            // U2 (my branches) fails transiently; U1 still succeeds.
            order.push('u2');
            return Promise.reject(new Error('socket timeout'));
          }
          order.push(ids ? `ids:${ids.join(',')}` : `${name}:${method}`);
          return original(args);
        });
      }
      return svc;
    };
    const { result } = renderHook(() => useAgorData(mock.client, authority));
    await waitForInitialLoad(result);
    const u1OnlyRead = () =>
      order.findIndex((entry) => entry.startsWith('ids:') && entry.includes('b-old'));
    await waitFor(() => {
      expect(order).toContain('sessions:findAll');
      expect(u1OnlyRead()).toBeGreaterThanOrEqual(0);
    });
    releaseGlobalBranches();
    expect(order).toContain('u2');
    expect(u1OnlyRead()).toBeLessThan(order.indexOf('sessions:findAll'));
    expect(u1OnlyRead()).toBeLessThan(order.indexOf('branches:findAll'));
  });

  it("never applies a load that outlived its mount into the next user's store", async () => {
    window.history.pushState({}, '', '/');
    const seed: Record<string, unknown[]> = {
      'sessions:find': [makeSession({ session_id: 's-alice', created_by: 'user-alice' })],
    };
    const { client, onFetch, fetchArguments } = makeMockClient(seed);
    const aliceRead = deferred();
    // Hold Alice's gated my-sessions page (call 1); Bob's (call 2) answers at once.
    onFetch('sessions', 'find', (call) => (call === 1 ? aliceRead.promise : undefined));
    onFetch('sessions', 'findAll', never);
    const alice = renderHook(() =>
      useAgorData(client, { ...authority, authenticatedUserId: 'user-alice' })
    );
    await waitFor(() => expect(fetchArguments('sessions', 'find')).toHaveLength(1));
    alice.unmount();

    // The response is captured at call time, so Bob's page differs from Alice's.
    seed['sessions:find'] = [makeSession({ session_id: 's-bob', created_by: 'user-bob' })];
    const bob = renderHook(() =>
      useAgorData(client, { ...authority, authenticatedUserId: 'user-bob' })
    );
    try {
      await waitForInitialLoad(bob.result);
      await waitFor(() => expect(agorStore.getState().mySessionsLoaded).toBe(true));
      const readsBefore = fetchArguments('branches', 'findAll').length;

      await act(async () => {
        aliceRead.resolve();
        await aliceRead.promise;
        // Long enough for an unfenced load to pass its indexing frame and apply.
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
      });
      const state = agorStore.getState();
      expect(state.sessionById.has('s-alice')).toBe(false);
      expect(state.sessionById.has('s-bob')).toBe(true);
      // Alice's load neither started a user scope nor read anything after teardown.
      expect(fetchArguments('branches', 'findAll')).toHaveLength(readsBefore);
      expect(
        fetchArguments('branches', 'findAll').some(
          (args) => (args as { query?: { created_by?: string } }).query?.created_by === 'user-alice'
        )
      ).toBe(false);
    } finally {
      bob.unmount();
    }
  });

  it('completes Home from the global snapshots against an older daemon that rejects every new key', async () => {
    window.history.pushState({}, '', '/');
    const mine = makeSession({ session_id: 's-mine', created_by: 'user-me', branch_id: 'b-1' });
    const lost = makeSession({ session_id: 's-lost', created_by: 'user-me', branch_id: 'b-gone' });
    const mock = makeMockClient({
      'sessions:find': [mine],
      'sessions:findAll': [mine, lost],
      'branches:findAll': [makeBranch({ branch_id: 'b-1', created_by: 'user-me' })],
    });
    // The pre-PR validator: `created_by` with `$count: false`, `teammate`,
    // branch `created_by` and id lists are all rejected with 400, every time.
    const rejected: unknown[] = [];
    const isNewKey = (name: string, query: Record<string, unknown> = {}) =>
      (name === 'sessions' && query.created_by !== undefined) ||
      (name === 'branches' &&
        (query.created_by !== undefined ||
          query.teammate !== undefined ||
          typeof query.branch_id === 'object'));
    const service = mock.client.service;
    (mock.client as { service: unknown }).service = (name: string) => {
      const svc = service(name);
      for (const method of ['find', 'findAll'] as const) {
        const original = svc[method];
        svc[method] = vi.fn((args?: { query?: Record<string, unknown> }) => {
          if (isNewKey(name, args?.query)) {
            rejected.push(args?.query);
            return Promise.reject(
              Object.assign(new Error('Invalid query'), { name: 'BadRequest', code: 400 })
            );
          }
          return original(args);
        });
      }
      return svc;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useAgorData(mock.client, authority));
      await waitForInitialLoad(result);
      expect(result.current.error).toBeNull();
      await waitFor(() => {
        const state = agorStore.getState();
        expect(state.userScopeDegraded).toBe(true);
        expect(state.mySessionsLoaded).toBe(true);
        expect(state.teammatesLoaded).toBe(true);
        expect(state.homeBranchesLoaded).toBe(true);
      });
      expect(agorStore.getState().sessionById.has('s-lost')).toBe(true);
      expect([...agorStore.getState().absentBranchIds]).toEqual(['b-gone']);
      // Only the gated page probed the new keys; the scope sent none after it.
      expect(rejected).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('still gates a board route on its board objects and cards', async () => {
    window.history.pushState({}, '', '/b/displayed/');
    const gate = deferred();
    const { client, onFetch } = makeMockClient({
      boards: [{ board_id: 'board-D', slug: 'displayed', name: 'Displayed' }],
    });
    onFetch('cards', 'findAll', (call) => (call === 1 ? gate.promise : undefined));
    try {
      const { result } = renderHook(() => useAgorData(client, authority));
      await waitFor(() =>
        expect(result.current.initialLoadItems.find((i) => i.key === 'boards')?.done).toBe(true)
      );
      expect(result.current.initialLoadComplete).toBe(false);
      expect(result.current.initialLoadItems.map((item) => item.key)).toContain('cards');
      gate.resolve();
      await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));
    } finally {
      gate.resolve();
      window.history.pushState({}, '', '/');
    }
  });
});

describe('useAgorData — reconnect reconciles the displayed partition', () => {
  const boardA = { board_id: 'board-A', slug: 'displayed', name: 'Displayed' };
  const fullA = { ...boardA, objects: { 'zone-1': { type: 'zone', x: 0, y: 0 } } };
  const card = (id: string, title = id) => ({ card_id: id, board_id: 'board-A', title });

  function boardRoute() {
    window.history.pushState({}, '', '/b/displayed/');
    onTestFinished(() => window.history.pushState({}, '', '/'));
  }

  it('drops deletions, applies moves and archives missed while disconnected, and unloads other boards', async () => {
    boardRoute();
    const seed: Record<string, unknown[]> = {
      boards: [boardA],
      'boards:get': fullA as never,
      'branches:findAll': [
        makeBranch({ branch_id: 'b-1', board_id: 'board-A' }),
        makeBranch({ branch_id: 'b-arch', board_id: 'board-A' }),
      ],
      'board-objects:findAll': [
        makeBoardObject({ object_id: 'bo-1', board_id: 'board-A', branch_id: 'b-1' }),
        makeBoardObject({ object_id: 'bo-arch', board_id: 'board-A', branch_id: 'b-arch' }),
        makeBoardObject({ object_id: 'bo-card', board_id: 'board-A', branch_id: undefined }),
        makeBoardObject({ object_id: 'bo-deleted', board_id: 'board-A', branch_id: undefined }),
      ],
      cards: [card('k-1'), card('k-deleted')],
    };
    const { client, emitIo, fetchArguments } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();
    // Another board was loaded before the disconnect.
    markBoardPartitionLoaded('board-B', captureLoadLifetime()!);
    expect(agorStore.getState().cardById.has('k-deleted')).toBe(true);

    // While disconnected: a card and a board object deleted, a placement
    // moved, a card edited, a branch archived (its placement stays, as on the
    // server).
    seed['branches:findAll'] = [makeBranch({ branch_id: 'b-1', board_id: 'board-A' })];
    seed['board-objects:findAll'] = [
      makeBoardObject({ object_id: 'bo-1', board_id: 'board-A', branch_id: 'b-1' }),
      makeBoardObject({ object_id: 'bo-arch', board_id: 'board-A', branch_id: 'b-arch' }),
      makeBoardObject({
        object_id: 'bo-card',
        board_id: 'board-A',
        branch_id: undefined,
        position: { x: 300, y: 400 },
      }),
    ];
    seed.cards = [card('k-1', 'edited')];
    act(() => emitIo('connect'));

    await waitFor(() => expect(agorStore.getState().cardById.has('k-deleted')).toBe(false));
    const state = agorStore.getState();
    expect([...state.cardById.keys()]).toEqual(['k-1']);
    expect(state.cardById.get('k-1')?.title).toBe('edited');
    expect([...state.boardObjectById.keys()].sort()).toEqual(['bo-1', 'bo-arch', 'bo-card']);
    expect(state.boardObjectById.get('bo-card')?.position).toEqual({ x: 300, y: 400 });
    expect(state.branchById.has('b-arch')).toBe(false);
    expect(state.boardById.get('board-A')?.objects).toBeDefined();
    // The displayed board is complete again; every other board is unloaded.
    expect(state.boardPartitions.get('board-A')?.status).toBe('loaded');
    expect(state.boardPartitions.has('board-B')).toBe(false);
    expect([...state.globallyHydrated].sort()).toEqual(['branches', 'sessions']);
    // Annotations were read for the displayed board only.
    const resyncReads = [
      fetchArguments('board-objects', 'findAll').at(-1),
      fetchArguments('cards', 'findAll').at(-1),
    ] as Array<{ query?: unknown }>;
    for (const read of resyncReads) expect(read.query).toMatchObject({ board_id: 'board-A' });
  });

  it('keeps rows written live while the resync was in flight', async () => {
    boardRoute();
    const seed: Record<string, unknown[]> = {
      boards: [boardA],
      'boards:get': fullA as never,
      cards: [card('k-1', 'server')],
    };
    const { client, emit, emitIo, onFetch } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();

    let reconnecting = false;
    onFetch('cards', 'findAll', () => {
      if (!reconnecting) return undefined;
      // Realtime during the resync's read: a card created and one patched.
      emit('cards', 'created', card('k-live'));
      emit('cards', 'patched', card('k-1', 'live'));
      return undefined;
    });
    reconnecting = true;
    act(() => emitIo('connect'));
    await waitFor(() => expect(agorStore.getState().cardById.has('k-live')).toBe(true));
    await flush();
    expect(agorStore.getState().cardById.get('k-1')?.title).toBe('live');
    expect(agorStore.getState().cardById.has('k-live')).toBe(true);
  });

  it('on Home reads no board objects or cards and unloads every board', async () => {
    const { client, emitIo, fetchCount } = makeMockClient({});
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();
    markBoardPartitionLoaded('board-B', captureLoadLifetime()!);
    const before = {
      objects: fetchCount('board-objects', 'findAll'),
      cards: fetchCount('cards', 'findAll'),
      sessions: fetchCount('sessions', 'findAll'),
    };

    act(() => emitIo('connect'));
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBeGreaterThan(before.sessions));
    await flush();
    expect(fetchCount('board-objects', 'findAll')).toBe(before.objects);
    expect(fetchCount('cards', 'findAll')).toBe(before.cards);
    expect(agorStore.getState().boardPartitions.size).toBe(0);
  });
});

describe('useAgorData — reconnect follows the board the UI displays', () => {
  it('reconciles an artifact route board (resolved by the UI, not the URL)', async () => {
    window.history.pushState({}, '', '/a/01a0fdaa/');
    onTestFinished(() => window.history.pushState({}, '', '/'));
    const board = { board_id: 'board-art', slug: 'art', name: 'Artifact board' };
    const seed: Record<string, unknown[]> = {
      boards: [board],
      'boards:get': { ...board, objects: { z: { type: 'zone' } } } as never,
      cards: [{ card_id: 'k-1', board_id: 'board-art', title: 'one' }],
    };
    const { client, emitIo, fetchArguments } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();
    // The UI resolved the artifact's board and shows it (useBoardPartition).
    const unregister = registerDisplayedBoard('board-art');
    onTestFinished(unregister);

    act(() => emitIo('connect'));
    await waitFor(() =>
      expect(agorStore.getState().boardPartitions.get('board-art')?.status).toBe('loaded')
    );
    expect(fetchArguments('cards', 'findAll').at(-1)).toMatchObject({
      query: { board_id: 'board-art' },
    });
    expect(agorStore.getState().boardById.get('board-art')?.objects).toBeDefined();
  });
});

describe('useAgorData — reauthentication reads the displayed board once', () => {
  it('the partition hook does not race the resync for the displayed board', async () => {
    window.history.pushState({}, '', '/b/board-one/');
    onTestFinished(() => window.history.pushState({}, '', '/'));
    const board = { board_id: 'board-1', slug: 'board-one', name: 'Board one' };
    const { client, fetchArguments } = makeMockClient({
      boards: [board],
      'boards:get': board as never,
    });
    const options = (generation: number) => ({
      authenticatedUserId: 'user-a',
      authenticatedUserRole: 'member',
      authGeneration: generation,
      connectionReady: true,
    });
    const { result, rerender } = renderHook(
      ({ generation }) => {
        const data = useAgorData(client, options(generation));
        useBoardPartition(client, 'board-1', { canUseMemberWorkspaceServices: true });
        return data;
      },
      { initialProps: { generation: 1 } }
    );
    await waitForInitialLoad(result);
    await flush();
    const boardReads = () =>
      (
        fetchArguments('board-objects', 'findAll') as Array<{ query?: { board_id?: string } }>
      ).filter((args) => args.query?.board_id === 'board-1').length;
    const before = boardReads();

    rerender({ generation: 2 }); // reauthenticated: partitions reset, silent resync
    await waitFor(() =>
      expect(agorStore.getState().boardPartitions.get('board-1')?.status).toBe('loaded')
    );
    await flush();
    expect(boardReads() - before).toBe(1);
  });
});

describe('useAgorData — navigating while a reconnect resync runs', () => {
  it('the destination board still loads after the resync resets every partition', async () => {
    window.history.pushState({}, '', '/b/board-a/');
    onTestFinished(() => window.history.pushState({}, '', '/'));
    const boardA = { board_id: 'board-a', slug: 'board-a', name: 'A' };
    const boardB = { board_id: 'board-b', slug: 'board-b', name: 'B' };
    const { client, emitIo, onFetch, fetchArguments } = makeMockClient({
      boards: [boardA, boardB],
      'boards:get': boardA as never,
    });
    const { result, rerender } = renderHook(
      ({ boardId }) => {
        const data = useAgorData(client);
        useBoardPartition(client, boardId, { canUseMemberWorkspaceServices: true });
        return data;
      },
      { initialProps: { boardId: 'board-a' } }
    );
    await waitForInitialLoad(result);
    await flush();

    // Hold the resync in its board-scoped batch (A is already resolved).
    const resync = deferred();
    onFetch('board-comments', 'findAll', (call) => (call === 2 ? resync.promise : undefined));
    // Hold B's first partition read.
    const firstB = deferred();
    let bReads = 0;
    onFetch('cards', 'findAll', () => {
      const args = fetchArguments('cards', 'findAll').at(-1) as { query?: { board_id?: string } };
      if (args.query?.board_id !== 'board-b') return undefined;
      bReads += 1;
      return bReads === 1 ? firstB.promise : undefined;
    });
    act(() => emitIo('connect'));
    await flush();

    // Navigate to B: its partition read starts while the resync is held.
    window.history.pushState({}, '', '/b/board-b/');
    rerender({ boardId: 'board-b' });
    await waitFor(() => expect(bReads).toBe(1));

    // The resync finishes (resetting every entry), then B's first read lands.
    await act(async () => {
      resync.resolve();
      await resync.promise;
    });
    await flush();
    await act(async () => {
      firstB.resolve();
      await firstB.promise;
    });
    await waitFor(() =>
      expect(agorStore.getState().boardPartitions.get('board-b')?.status).toBe('loaded')
    );
    expect(bReads).toBe(2);
  });
});

describe('useAgorData — navigating during the resync light batch', () => {
  it.each(['loaded', 'in flight'])(
    'reuses the destination board partition load (%s) instead of reading the board again',
    async (state) => {
      window.history.pushState({}, '', '/b/board-a/');
      onTestFinished(() => window.history.pushState({}, '', '/'));
      const boardA = { board_id: 'board-a', slug: 'board-a', name: 'A' };
      const boardB = { board_id: 'board-b', slug: 'board-b', name: 'B' };
      const { client, emitIo, onFetch, fetchArguments } = makeMockClient({
        boards: [boardA, boardB],
        'boards:get': boardA as never,
      });
      const { result, rerender } = renderHook(
        ({ boardId }) => {
          const data = useAgorData(client);
          useBoardPartition(client, boardId, { canUseMemberWorkspaceServices: true });
          return data;
        },
        { initialProps: { boardId: 'board-a' } }
      );
      await waitForInitialLoad(result);
      await flush();

      // Hold the resync in its light batch, before it resolves a board.
      const light = deferred();
      onFetch('card-types', 'findAll', (call) => (call === 2 ? light.promise : undefined));
      const boardReads = (service: 'cards' | 'board-objects') =>
        fetchArguments(service, 'findAll').filter(
          (args) => (args as { query?: { board_id?: string } }).query?.board_id === 'board-b'
        ).length;
      // 'in flight': B's partition read is still pending when the resync
      // resolves its board.
      const heldB = deferred();
      onFetch('cards', 'findAll', () => {
        const args = fetchArguments('cards', 'findAll').at(-1) as { query?: { board_id?: string } };
        return state === 'in flight' && args.query?.board_id === 'board-b'
          ? heldB.promise
          : undefined;
      });
      act(() => emitIo('connect'));
      await flush();

      // Navigate to B: its partition read starts while the resync is held.
      window.history.pushState({}, '', '/b/board-b/');
      rerender({ boardId: 'board-b' });
      await waitFor(() => expect(boardReads('cards')).toBe(1));

      await act(async () => {
        light.resolve();
        await light.promise;
      });
      await flush();
      await act(async () => {
        heldB.resolve();
        await heldB.promise;
      });
      await flush();
      await waitFor(() =>
        expect(agorStore.getState().boardPartitions.get('board-b')?.status).toBe('loaded')
      );
      await flush();
      // One read of B's annotations: the resync reused B's in-flight load.
      expect(boardReads('cards')).toBe(1);
      expect(boardReads('board-objects')).toBe(1);
      expect(agorStore.getState().boardPartitions.get('board-b')?.status).toBe('loaded');
    }
  );
});
