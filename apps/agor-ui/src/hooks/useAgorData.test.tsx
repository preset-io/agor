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
import { holdBackgroundReads } from '../store/backgroundReads';
import {
  loadBoardPartition,
  makeBoardReadySelector,
  registerBoardUse,
  selectBoardPartition,
} from '../store/boardPartitions';
// Session `patched`/`updated` writes are coalesced to one flush per frame (see
// realtimeBatch); flush synchronously in tests that assert the post-patch store.
import { flushRealtimeNow } from '../store/realtimeBatch';
import { holdRows } from '../store/retention';
import { boardScopeKey, USER_SCOPE_KEYS } from '../store/scopeMerge';
import { makeBranchesForBoardSelector } from '../store/selectors';
import { loadSessionMcpServerIds } from '../store/sessionMcpLinks';
import {
  fillOnDemand,
  selectHomeBranchesLoaded,
  selectMySessionsLoaded,
  selectTeammatesLoaded,
  selectTeammatesTruncated,
} from '../store/userScope';
import { deferred } from '../test/harness';
import { markBoardLoaded } from '../test/userScopeCoverage';
import { useAgorData } from './useAgorData';
import { useBoardPartition } from './useBoardPartition';
import { recentBoardsStorageKey } from './useRecentBoards';

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
 * `findAll` and `find`. When a page read (`find`) and a full read (`findAll`)
 * need DIFFERENT data, a method-specific key (`sessions:findAll`,
 * `sessions:find`) takes precedence over the bare name when present. `name:get` seeds `get`. A seed
 * may also be a function of the call's query (a scoped server, see `fakeServer`).
 */
function makeMockClient(seed: Record<string, unknown[] | Record<string, unknown>> = {}) {
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

  const respond = async (name: string, method: 'findAll' | 'find', args?: unknown) => {
    const key = `${name}:${method}`;
    const call = (fetchCounts.get(key) ?? 0) + 1;
    fetchCounts.set(key, call);
    const gate = fetchHooks.get(key)?.(call);
    const entry: unknown = seed[key] ?? seed[name] ?? [];
    const data =
      typeof entry === 'function'
        ? entry((args as { query?: Record<string, unknown> } | undefined)?.query ?? {})
        : entry;
    if (gate && typeof (gate as { then?: unknown }).then === 'function') {
      await gate;
    }
    return data;
  };

  const recordAndRespond = (name: string, method: 'findAll' | 'find', args: unknown) => {
    const key = `${name}:${method}`;
    fetchArguments.set(key, [...(fetchArguments.get(key) ?? []), args]);
    return respond(name, method, args);
  };

  const service = (name: string) => ({
    findAll: vi.fn((args) => recordAndRespond(name, 'findAll', args)),
    find: vi.fn((args) => recordAndRespond(name, 'find', args)),
    get: vi.fn((id: unknown) => {
      const key = `${name}:get`;
      fetchCounts.set(key, (fetchCounts.get(key) ?? 0) + 1);
      fetchArguments.set(key, [...(fetchArguments.get(key) ?? []), id]);
      const gate = fetchHooks.get(key)?.(fetchCounts.get(key)!);
      // A function seed answers by id.
      const entry: unknown = seed[key];
      return Promise.resolve(gate).then(() =>
        typeof entry === 'function' ? entry(id) : (entry ?? null)
      );
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

type Row = Record<string, unknown>;

/**
 * A daemon that answers branch and session reads by their query (the keys
 * the scoped loaders send: `archived`, `created_by`, `board_id`, `teammate`,
 * `branch_id.$in`, `$limit`), over rows a test mutates between calls.
 * `find` answers a page (`{ data, total }`), `findAll` the rows.
 */
function fakeServer(seed: Record<string, unknown[]>, rows: { branches: Row[]; sessions: Row[] }) {
  const boardOf = (session: Row) =>
    rows.branches.find((branch) => branch.branch_id === session.branch_id)?.board_id;
  const matches = (row: Row, query: Record<string, unknown>, boardId: unknown) => {
    const ids = (query.branch_id as { $in?: string[] } | undefined)?.$in;
    const teammate = (row.custom_context as { teammate?: { kind?: string } } | undefined)?.teammate;
    return (
      (query.archived === undefined || !!row.archived === query.archived) &&
      (query.created_by === undefined || row.created_by === query.created_by) &&
      (query.board_id === undefined || boardId === query.board_id) &&
      (!query.teammate || teammate?.kind === 'teammate') &&
      (!ids || ids.includes(row.branch_id as string))
    );
  };
  const read = (collection: 'branches' | 'sessions', query: Record<string, unknown>) => {
    const found =
      collection === 'branches'
        ? rows.branches.filter((branch) => matches(branch, query, branch.board_id))
        : rows.sessions
            .map((session) => ({ ...session, branch_board_id: boardOf(session) }))
            .filter((session) => matches(session, query, session.branch_board_id));
    return found.slice(0, (query.$limit as number | undefined) ?? found.length);
  };
  const total = (collection: 'branches' | 'sessions', query: Record<string, unknown>) =>
    read(collection, { ...query, $limit: undefined }).length;
  for (const collection of ['branches', 'sessions'] as const) {
    seed[`${collection}:findAll`] = ((query: Record<string, unknown>) =>
      read(collection, query)) as never;
    seed[`${collection}:find`] = ((query: Record<string, unknown>) => ({
      data: read(collection, query),
      total: total(collection, query),
    })) as never;
  }
  return seed;
}

/** Whether a branch or session read was unscoped (read the global set). */
const globalReads = (reads: unknown[]) =>
  reads.filter((args) => {
    const query = (args as { query?: Record<string, unknown> }).query ?? {};
    return !query.board_id && !query.created_by && !query.teammate && !query.branch_id;
  });

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

// Rows live on `board-1` by default: on its route (`onBoardRoute`) its
// partition holds them, so realtime writes to them are admitted.
const makeBranch = (overrides: Record<string, unknown> = {}) => ({
  branch_id: 'b-1',
  board_id: 'board-1',
  repo_id: 'r-1',
  name: 'main',
  status: 'idle',
  archived: false,
  ...overrides,
});

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  session_id: 's-1',
  branch_id: 'b-1',
  branch_board_id: 'board-1',
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
  // The first paint opens the gate, but the background hydrations (the
  // optional mcp/gateway/artifact/oauth slices) and the user scope are kicked
  // off right after and apply a beat later, which changes map references even
  // when content is identical. Flush a macrotask so it settles before tests capture
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

describe('useAgorData — network recovery', () => {
  it('lets the first successful reconnect finish a failed bootstrap and clear its error', async () => {
    const { client, emitIo, onFetch } = makeMockClient();
    onFetch('boards', 'findAll', (call) =>
      call === 1 ? Promise.reject(new Error('Network unavailable')) : undefined
    );
    const { result, unmount } = renderHook(() => useAgorData(client));
    try {
      await waitFor(() => expect(result.current.error).toBe('Network unavailable'));
      expect(result.current.initialLoadComplete).toBe(false);

      act(() => emitIo('connect'));
      await waitFor(() => {
        expect(result.current.error).toBeNull();
        expect(result.current.initialLoadComplete).toBe(true);
      });
    } finally {
      unmount();
    }
  });
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
      // Comments are global on every route, never board-scoped.
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

  it('fills a /w/ branch the store lacks after the initial load, joining no scope', async () => {
    const target = makeBranch({ branch_id: 'b-target-full', board_id: 'board-x' });
    const { client, fetchArguments } = makeMockClient({ branches: [], 'branches:get': target });
    const { result } = renderHook(() => useAgorData(client, { directBranchId: 'b-target' }));
    await waitForInitialLoad(result);
    await waitFor(() =>
      expect(agorStore.getState().branchById.get('b-target-full')).toMatchObject({
        board_id: 'board-x',
      })
    );
    expect(fetchArguments('branches', 'get')).toEqual(['b-target']);
    expect(
      [...agorStore.getState().coverage.values()].some((entry) =>
        entry.members?.branches?.has('b-target-full')
      )
    ).toBe(false);
  });

  for (const archived of [false, true]) {
    it(`never resurrects a deep-link target removed while its get was in flight (archived=${archived})`, async () => {
      const stale = makeSession({ session_id: 's-target', archived });
      let release!: () => void;
      const { client, emit, onFetch } = makeMockClient({
        sessions: [],
        'sessions:get': stale as never,
      });
      // The first-paint get misses; the post-load fallback's get is held open.
      onFetch('sessions', 'get', (call) =>
        call === 1
          ? Promise.reject(new Error('NotFound'))
          : new Promise<void>((resolve) => {
              release = resolve;
            })
      );
      const { result } = renderHook(() => useAgorData(client, { directSessionId: 's-target' }));
      await waitForInitialLoad(result);
      await waitFor(() => expect(release).toBeDefined());
      act(() => emit('sessions', 'removed', stale));
      await act(async () => release());
      expect(agorStore.getState().sessionById.has('s-target')).toBe(false);
      expect(agorStore.getState().missingLinkTargets.has('s-target')).toBe(true);
    });
  }

  it('records a link target only once its targeted get missed', async () => {
    let reject!: (err: Error) => void;
    const { client, onFetch } = makeMockClient({ sessions: [] });
    // The first-paint get misses; the post-load fallback's get is held open.
    onFetch('sessions', 'get', (call) =>
      call === 1
        ? Promise.reject(new Error('NotFound'))
        : new Promise((_, fail) => {
            reject = fail;
          })
    );
    const { result } = renderHook(() => useAgorData(client, { directSessionId: 'gone' }));
    await waitForInitialLoad(result);
    await waitFor(() => expect(reject).toBeDefined());
    expect(agorStore.getState().missingLinkTargets.has('gone')).toBe(false);
    await act(async () => reject(new Error('NotFound')));
    expect(agorStore.getState().missingLinkTargets.has('gone')).toBe(true);
  });

  it('keeps only the current link target among the missed ones', async () => {
    const { client, onFetch } = makeMockClient({ sessions: [] });
    onFetch('sessions', 'get', () => Promise.reject(new Error('NotFound')));
    const { result, rerender } = renderHook(
      ({ target }) => useAgorData(client, { directSessionId: target }),
      { initialProps: { target: 'gone-0' } }
    );
    await waitForInitialLoad(result);
    await waitFor(() => expect(agorStore.getState().missingLinkTargets.has('gone-0')).toBe(true));
    for (let i = 1; i < 5; i++) {
      rerender({ target: `gone-${i}` });
      await waitFor(() =>
        expect(agorStore.getState().missingLinkTargets.has(`gone-${i}`)).toBe(true)
      );
    }
    expect([...agorStore.getState().missingLinkTargets]).toEqual(['gone-4']);
  });

  it('asks the server for an ambiguous short id instead of waiting forever', async () => {
    const { client, fetchCount, onFetch } = makeMockClient({
      sessions: [makeSession({ session_id: 'abc-1' }), makeSession({ session_id: 'abc-2' })],
    });
    onFetch('sessions', 'get', () => Promise.reject(new Error('ambiguous')));
    const { result } = renderHook(() => useAgorData(client, { directSessionId: 'abc' }));
    await waitForInitialLoad(result);
    await waitFor(() => expect(agorStore.getState().missingLinkTargets.has('abc')).toBe(true));
    expect(fetchCount('sessions', 'get')).toBeGreaterThan(0);
  });

  it('drops a duplicate `sessions.patched` (content-equal) without changing byId references', async () => {
    const session = makeSession();
    const { client, emit } = makeMockClient(onBoardRoute({ sessions: [session] }));
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
    const { client, emit } = makeMockClient(onBoardRoute({ sessions: [session] }));
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
    const { client, emit } = makeMockClient(onBoardRoute({ sessions: [session] }));
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
    const { client, emit } = makeMockClient(onBoardRoute({ branches: [branch] }));
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const before = agorStore.getState().branchById;
    act(() => emit('branches', 'patched', { ...branch }));
    expect(agorStore.getState().branchById).toBe(before);
  });

  it('updates branchById when a branch field flips', async () => {
    const branch = makeBranch({ name: 'main' });
    const { client, emit } = makeMockClient(onBoardRoute({ branches: [branch] }));
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
    const { client, emit } = makeMockClient(onBoardRoute({ sessions: [session] }));
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
    const { client, emit } = makeMockClient(
      onBoardRoute({ sessions: [session], branches: [branch] })
    );
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
    const { client, emit } = makeMockClient(onBoardRoute({ sessions: [session] }));
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
    const { client, emit } = makeMockClient(onBoardRoute({ 'board-objects': [boardObject] }));
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    // The object moves to board-2, whose loaded partition holds it there.
    markBoardLoaded('board-2');

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
    const { client, emit } = makeMockClient(
      onBoardRoute({
        'board-objects': [currentBoardObject, otherBoardObject],
      })
    );
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    // board-2's loaded partition holds its object.
    markBoardLoaded('board-2');

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
 * Background hydration uses a "skip-apply-on-race" rule (see `runHydration`):
 * a full-set snapshot is applied WHOLESALE only when no live write to the
 * target collection raced the fetch. If one did, the snapshot is discarded and
 * refetched — never overlaid — and a persistent race triggers repeated
 * discard+refetch with capped exponential backoff until a quiet window allows
 * a wholesale apply: the apply is deferred, never permanently skipped. These
 * tests pin that contract on gateway channels (a collection that still
 * hydrates in full), using `onFetch` to land a live write mid-fetch.
 */
describe('useAgorData — skip-apply-on-race hydration', () => {
  const channel = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    ...overrides,
  });
  const has = (id: string) => agorStore.getState().gatewayChannelById.has(id);

  it('discards a racy snapshot, refetches, and applies the fresh one without clobbering the live write', async () => {
    const [g1, g2, g3] = [channel('g-1'), channel('g-2'), channel('g-3')];
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      // Once the race settles, the backend's full set already includes the
      // racing create (g-3) — models a real refetch reflecting the new row.
      'gateway-channels': [g1, g2, g3],
    });
    // A channel is created mid-flight on the FIRST hydration fetch only.
    onFetch('gateway-channels', 'findAll', (call) => {
      if (call === 1) emit('gateway-channels', 'created', g3);
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    // The first snapshot was discarded (it raced) and a second fetch applied.
    await waitFor(() => expect(has('g-2')).toBe(true));
    expect(fetchCount('gateway-channels', 'findAll')).toBe(2);
    expect(has('g-3')).toBe(true);
  });

  it('retries after races until a quiet window, then applies the fresh snapshot (never gives up)', async () => {
    const g1 = channel('g-1');
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      'gateway-channels': [g1, channel('g-2')],
    });
    // Race the first two fetches, then go quiet — the third (immediate) retry
    // sees a clean window and applies.
    onFetch('gateway-channels', 'findAll', (call) => {
      if (call <= 2) emit('gateway-channels', 'patched', { ...g1, name: `v${call}` });
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    await waitFor(() => expect(has('g-2')).toBe(true), { timeout: 4000 });
    // Applied on the first quiet window (3rd attempt) — not skipped forever.
    expect(fetchCount('gateway-channels', 'findAll')).toBe(3);
  });

  it('keeps retrying past the old bounded cap without resurrecting a removed row (never skips)', async () => {
    const [g1, g2] = [channel('g-1'), channel('g-2')];
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      // Stale backend snapshot ALWAYS still contains g-2: if it were ever
      // applied it would resurrect the removed channel.
      'gateway-channels': [g1, g2],
    });
    onFetch('gateway-channels', 'findAll', (call) => {
      // Insert g-1 and g-2 live, remove g-2 during the first fetch, then bump
      // the revision on every subsequent attempt so the hydration never sees
      // a quiet window.
      if (call === 1) {
        emit('gateway-channels', 'created', g1);
        emit('gateway-channels', 'created', g2);
        emit('gateway-channels', 'removed', g2);
      } else emit('gateway-channels', 'patched', { ...g1, name: `v${call}` });
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    // The loop never gives up — it keeps re-fetching past the old cap of 6
    // (proving "retry until quiet", not "skip after N").
    await waitFor(
      () => expect(fetchCount('gateway-channels', 'findAll')).toBeGreaterThanOrEqual(7),
      { timeout: 5000 }
    );

    expect(has('g-1')).toBe(true);
    // The stale snapshot was never applied (it never went quiet), so g-2 stays
    // removed — a racy snapshot is never force-applied.
    expect(has('g-2')).toBe(false);
  });

  it('applies an unrelated collection while another keeps racing (per-collection revisions)', async () => {
    const g1 = channel('g-1');
    const m1 = { mcp_server_id: 'm-1', name: 'one' };
    const m2 = { mcp_server_id: 'm-2', name: 'two' };
    const { client, emit, onFetch } = makeMockClient({
      'gateway-channels': [g1, channel('g-2')],
      'mcp-servers': [m1, m2],
    });
    // Keep the gateway-channels hydration perpetually racing…
    onFetch('gateway-channels', 'findAll', (call) =>
      emit('gateway-channels', 'patched', { ...g1, name: `v${call}` })
    );
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    // …the mcp-servers hydration is independent of it, so it applied.
    await waitFor(() => expect(agorStore.getState().mcpServerById.has('m-1')).toBe(true));
    expect(agorStore.getState().mcpServerById.has('m-2')).toBe(true);
    // …while the still-racing gateway-channels hydration has not applied.
    expect(has('g-2')).toBe(false);
  });

  it('runs backoff retries with delays preceding attempts (off-by-one)', async () => {
    const g1 = channel('g-1');
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      'gateway-channels': [g1, channel('g-2')],
    });
    // Race the first five fetches — pushing PAST the immediate-retry phase into
    // the backoff phase (attempts 5 & 6 are delayed) — then go quiet. The 6th
    // fetch must still run (its backoff delay PRECEDES it) and apply.
    onFetch('gateway-channels', 'findAll', (call) => {
      if (call <= 5) emit('gateway-channels', 'patched', { ...g1, name: `v${call}` });
    });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    await waitFor(() => expect(has('g-2')).toBe(true), { timeout: 4000 });
    expect(fetchCount('gateway-channels', 'findAll')).toBe(6);
  });
});

/**
 * The logout reset is NOT a `runHydration` apply: it MUST bump the hydration
 * generations and revisions so an in-flight hydration whose snapshot predates
 * it cannot repopulate the Maps after teardown.
 */
describe('useAgorData — bulk-write revision bumps', () => {
  it('logout reset bumps generation/revisions so an in-flight hydration cannot repopulate after logout', async () => {
    const seed: Record<string, unknown[]> = {
      'gateway-channels': [{ id: 'g-1', name: 'g-1' }],
    };
    const gate = deferred();
    const { client, onFetch, fetchCount } = makeMockClient(seed);
    onFetch('gateway-channels', 'findAll', (call) => (call === 1 ? gate.promise : undefined));

    const { result, rerender } = renderHook(
      ({ c }: { c: Parameters<typeof useAgorData>[0] }) => useAgorData(c),
      { initialProps: { c: client as Parameters<typeof useAgorData>[0] } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(fetchCount('gateway-channels', 'findAll')).toBe(1));

    // Logout: client → null fires the reset (clears Maps, cancels hydrations).
    await act(async () => {
      rerender({ c: null });
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    expect(agorStore.getState().gatewayChannelById.size).toBe(0);

    // Release the in-flight hydration. Its snapshot must NOT repopulate the
    // cleared Maps: the reset bumped the generation (cancels the loop) and the
    // revision (fails the quiet check).
    await act(async () => {
      gate.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await flush();
    expect(agorStore.getState().gatewayChannelById.size).toBe(0);
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
    const seed: Record<string, unknown[]> = {
      'sessions:find': [makeSession({ created_by: 'user-a' })],
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
      return [selectMySessionsLoaded(s), selectHomeBranchesLoaded(s), selectTeammatesLoaded(s)];
    };
    await waitFor(() => expect(scopeLoaded()).toEqual([true, true, true]));

    // Hold the resync's light batch so the reset flags can be observed first.
    const calls = fetchCount('boards', 'findAll');
    onFetch('boards', 'findAll', (call) => (call > calls ? gate.promise : undefined));
    seed['sessions:find'] = [makeSession({ created_by: 'user-b' })];
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
  it('reads no session↔MCP links globally, and realtime events apply to held sessions', async () => {
    const { client, emit, listeners, fetchCount } = makeMockClient(
      onBoardRoute({
        sessions: [makeSession(), makeSession({ session_id: 's-2' })],
        'session-mcp-servers': [{ session_id: 's-1', mcp_server_id: 'old-server' }],
      })
    );
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
    const seed = onBoardRoute({
      sessions: [makeSession(), makeSession({ session_id: 's-2' })],
      'session-mcp-servers': [{ session_id: 's-1', mcp_server_id: 'a' }],
    });
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

  it('releases the prefetch on unmount', async () => {
    const session = makeSession({ session_id: OPEN_ID });
    const { client } = makeMockClient({ 'sessions:get': session as never });
    const prefetch = deferredPrefetch();

    const { result, unmount } = renderHook(() => useAgorData(client, { directSessionId: OPEN_ID }));
    await waitForInitialLoad(result);
    unmount();
    expect(prefetch.release).toHaveBeenCalled();
  });

  it('abandons a load unmounted during the light batch (no prefetch, no maps)', async () => {
    transcriptPrefetch.prefetchOpenedTranscript.mockClear();
    const session = makeSession({ session_id: OPEN_ID });
    const { client, fetchCount, onFetch } = makeMockClient({ 'sessions:get': session as never });
    const light = deferred();
    onFetch('boards', 'findAll', () => light.promise);

    const { unmount } = renderHook(() => useAgorData(client, { directSessionId: OPEN_ID }));
    await waitFor(() => expect(fetchCount('boards', 'findAll')).toBe(1));
    unmount();
    await act(async () => {
      light.resolve();
      await new Promise((done) => setTimeout(done, 100));
      await flush();
    });

    expect(transcriptPrefetch.prefetchOpenedTranscript).not.toHaveBeenCalled();
    expect(fetchCount('board-comments', 'findAll')).toBe(0); // heavy batch never started
    expect(agorStore.getState().sessionById.size).toBe(0);
  });

  it('abandons a load unmounted during the heavy batch (prefetch released, nothing applied)', async () => {
    transcriptPrefetch.prefetchOpenedTranscript.mockClear();
    const session = makeSession({ session_id: OPEN_ID });
    const { client, fetchCount, onFetch } = makeMockClient({
      'sessions:get': session as never,
      'board-comments': [{ comment_id: 'c-1', board_id: 'board-1' }],
    });
    const heavy = deferred();
    // Comments are gated on every route and read after the light batch
    // applied, so holding them holds the load after its first apply.
    onFetch('board-comments', 'findAll', () => heavy.promise);
    const release = vi.fn();
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
      // Let a resumed load pass its requestAnimationFrame yield.
      await new Promise((done) => setTimeout(done, 100));
      await flush();
    });

    expect(transcriptPrefetch.prefetchOpenedTranscript).toHaveBeenCalledTimes(1);
    expect(agorStore.getState().commentById.size).toBe(0);
  });

  it('does not prefetch without a session route', async () => {
    transcriptPrefetch.prefetchOpenedTranscript.mockClear();
    const { client } = makeMockClient({ sessions: [makeSession()] });

    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(transcriptPrefetch.prefetchOpenedTranscript).not.toHaveBeenCalled();
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
    await waitFor(() => expect(selectTeammatesLoaded(agorStore.getState())).toBe(true));
    expect(u1Sent()).toBe(false);

    await act(async () => prefetch.resolve());
    await waitFor(() => expect(u1Sent()).toBe(true));
  });

  it('starts the user scope without waiting for the opened transcript', async () => {
    const session = makeSession({ session_id: OPEN_ID, created_by: 'user-me' });
    const { client, fetchArguments } = makeMockClient({ 'sessions:find': [session] });
    deferredPrefetch();

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

    // The transcript never becomes ready; my teammates (U3) load anyway.
    await waitFor(() =>
      expect(fetchArguments('branches', 'find')).toContainEqual({
        query: { teammate: true, archived: false, $limit: 1000 },
      })
    );
    await waitFor(() => expect(selectTeammatesLoaded(agorStore.getState())).toBe(true));
  });
});

describe('useAgorData — first paint holds the displayed board', () => {
  it("keeps another user's sessions created on the board before and during its read", async () => {
    const boardA = { board_id: 'board-A', slug: 'displayed', name: 'Displayed' };
    window.history.pushState({}, '', '/b/displayed/');
    onTestFinished(() => window.history.pushState({}, '', '/'));
    const server = {
      branches: [makeBranch({ branch_id: 'b-A', board_id: 'board-A', created_by: 'user-other' })],
      sessions: [makeSession({ session_id: 's-A', branch_id: 'b-A', created_by: 'user-other' })],
    };
    const seed = fakeServer({ boards: [boardA], 'boards:get': boardA as never }, server);
    const { client, emit, onFetch } = makeMockClient(seed);
    // Created on the server and announced live: one while the light batch
    // resolves the board, one while the board's own rows are being read.
    const create = (id: string) => {
      const row = makeSession({ session_id: id, branch_id: 'b-A', created_by: 'user-other' });
      server.sessions.push(row);
      emit('sessions', 'created', { ...row, branch_board_id: 'board-A' });
    };
    onFetch('boards', 'findAll', (call) => call === 1 && create('s-early'));
    onFetch('sessions', 'findAll', (call) => call === 1 && create('s-late'));
    const { result } = renderHook(() =>
      useAgorData(client, {
        authenticatedUserId: 'user-me',
        authenticatedUserRole: 'member',
        authGeneration: 1,
        connectionReady: true,
      })
    );
    await waitForInitialLoad(result);
    const state = agorStore.getState();
    expect(selectBoardPartition(state, 'board-A')?.status).toBe('loaded');
    expect(['s-A', 's-early', 's-late'].filter((id) => !state.sessionById.has(id))).toEqual([]);
    expect(selectBoardPartition(state, 'board-A')?.members?.sessions).toEqual(
      new Set(['s-A', 's-early', 's-late'])
    );
  });
});

describe('useAgorData — user-scoped first paint', () => {
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
    const { result } = renderHook(() => useAgorData(client, authority));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.initialLoadComplete).toBe(true);
    });
    // The gated page is MY sessions.
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
    await waitFor(() => expect(selectMySessionsLoaded(agorStore.getState())).toBe(true));
  });

  it('opens the gate when the my-sessions page fails, and U1 reads my sessions', async () => {
    window.history.pushState({}, '', '/');
    const mine = makeSession({ session_id: 's-mine', created_by: 'user-me' });
    const { client, fetchArguments, onFetch } = makeMockClient({ 'sessions:find': [mine] });
    // Call 1 is the gated my-sessions page; call 2 is U1.
    onFetch('sessions', 'find', (call) =>
      call === 1 ? Promise.reject(new Error('socket timeout')) : undefined
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useAgorData(client, authority));
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.initialLoadComplete).toBe(true);
      });
      expect(result.current.error).toBeNull();
      await waitFor(() => expect(agorStore.getState().sessionById.has('s-mine')).toBe(true));
      expect(
        (fetchArguments('sessions', 'find')[1] as { query: { $limit?: number } }).query.$limit
      ).toBe(10000);
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
    const page = deferred();
    onFetch('sessions', 'find', (call) => (call === 1 ? page.promise : undefined));
    const { result } = renderHook(() => useAgorData(client, authority));
    await waitFor(() => expect(fetchArguments('sessions', 'find')).toHaveLength(1));

    // My new session arrives live while the gated page is still pending.
    const created = makeSession({ session_id: 's-new', created_by: 'user-me' });
    act(() => emit('sessions', 'created', created));
    await act(async () => {
      page.resolve();
      await page.promise;
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

  it("never applies a load that outlived its mount into the next user's store", async () => {
    window.history.pushState({}, '', '/');
    const seed: Record<string, unknown[]> = {
      'sessions:find': [makeSession({ session_id: 's-alice', created_by: 'user-alice' })],
    };
    const { client, onFetch, fetchArguments } = makeMockClient(seed);
    const aliceRead = deferred();
    // Hold Alice's gated my-sessions page (call 1); Bob's (call 2) answers at once.
    onFetch('sessions', 'find', (call) => (call === 1 ? aliceRead.promise : undefined));
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
      await waitFor(() => expect(selectMySessionsLoaded(agorStore.getState())).toBe(true));
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

  it('still gates a board route on its board partition', async () => {
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
      expect(result.current.initialLoadItems.map((item) => item.key)).toContain('board');
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
    markBoardLoaded('board-B');
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
    expect(selectBoardPartition(state, 'board-A')?.status).toBe('loaded');
    // It commits what the resync read for the board.
    const members = selectBoardPartition(state, 'board-A')?.members;
    expect([...(members?.cards ?? [])]).toEqual(['k-1']);
    expect([...(members?.boardObjects ?? [])].sort()).toEqual(['bo-1', 'bo-arch', 'bo-card']);
    expect([...(members?.branches ?? [])]).toEqual(['b-1']);
    expect(state.coverage.has(boardScopeKey('board-B'))).toBe(false);
    // Annotations were read for the displayed board only.
    const resyncReads = [
      fetchArguments('board-objects', 'findAll').at(-1),
      fetchArguments('cards', 'findAll').at(-1),
    ] as Array<{ query?: unknown }>;
    for (const read of resyncReads) expect(read.query).toMatchObject({ board_id: 'board-A' });
  });

  it('keeps the displayed board loaded in every update of the resync', async () => {
    boardRoute();
    const seed: Record<string, unknown[]> = {
      boards: [boardA],
      'boards:get': fullA as never,
      cards: [card('k-1'), card('k-deleted')],
    };
    const { client, emitIo } = makeMockClient(seed);
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();
    expect(selectBoardPartition(agorStore.getState(), 'board-A')?.status).toBe('loaded');
    const statuses: Array<string | undefined> = [];
    const off = agorStore.subscribe((s) => {
      statuses.push(selectBoardPartition(s, 'board-A')?.status);
    });
    seed.cards = [card('k-1')];
    act(() => emitIo('connect'));
    await waitFor(() => expect(agorStore.getState().cardById.has('k-deleted')).toBe(false));
    await flush();
    off();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.filter((status) => status !== 'loaded')).toEqual([]);
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
    markBoardLoaded('board-B');
    const before = {
      objects: fetchCount('board-objects', 'findAll'),
      cards: fetchCount('cards', 'findAll'),
      boards: fetchCount('boards', 'findAll'),
    };

    act(() => emitIo('connect'));
    await waitFor(() => expect(fetchCount('boards', 'findAll')).toBeGreaterThan(before.boards));
    await flush();
    expect(fetchCount('board-objects', 'findAll')).toBe(before.objects);
    expect(fetchCount('cards', 'findAll')).toBe(before.cards);
    expect(
      [...agorStore.getState().coverage.keys()].filter((key) => key.startsWith('board:'))
    ).toEqual([]);
  });
});

describe('useAgorData — reads in flight across a reconnect resync', () => {
  it('an on-demand read sent before the resync is sent again instead of applying', async () => {
    const { client, emitIo } = makeMockClient({});
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);
    await flush();
    const stale = deferred();
    let reads = 0;
    const hold = holdRows();
    onTestFinished(() => hold.release());
    const fill = fillOnDemand(async () => {
      reads += 1;
      if (reads === 1) await stale.promise;
      return { sessions: [] };
    }, hold);
    act(() => emitIo('connect'));
    await act(async () => {
      stale.resolve();
      await fill;
    });
    expect(reads).toBe(2);
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
    const unregister = registerBoardUse('board-art');
    onTestFinished(unregister);

    act(() => emitIo('connect'));
    await waitFor(() =>
      expect(selectBoardPartition(agorStore.getState(), 'board-art')?.status).toBe('loaded')
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
      expect(selectBoardPartition(agorStore.getState(), 'board-1')?.status).toBe('loaded')
    );
    await flush();
    expect(boardReads() - before).toBe(1);
  });
});

describe('useAgorData — a reconnect reconciles background-loaded boards', () => {
  it('drops rows archived or revoked while disconnected', async () => {
    const boards = [1, 2, 3].map((n) => ({
      board_id: `board-${n}`,
      slug: `board-${n}`,
      name: `Board ${n}`,
    }));
    const theirs = (n: number) =>
      makeBranch({ branch_id: `b-${n}`, board_id: `board-${n}`, created_by: 'user-b' }) as Row;
    const session = (n: number) =>
      makeSession({ session_id: `s-${n}`, branch_id: `b-${n}`, created_by: 'user-b' }) as Row;
    const server = {
      branches: [theirs(1), theirs(2), theirs(3)],
      sessions: [session(1), session(2), session(3)],
    };
    const { client } = makeMockClient(
      fakeServer(
        { boards, 'boards:get': ((id: string) => boards.find((b) => b.board_id === id)) as never },
        server
      )
    );
    const options = (connectionReady: boolean) => ({
      authenticatedUserId: 'user-a',
      authenticatedUserRole: 'member',
      authGeneration: 1,
      connectionReady,
    });
    const { result, rerender } = renderHook(
      ({ connected }) => useAgorData(client, options(connected)),
      { initialProps: { connected: true } }
    );
    await waitForInitialLoad(result);
    // Home, with three boards loaded in the background (navigated away from).
    await act(async () => {
      await Promise.all(
        boards.map((b) =>
          loadBoardPartition(client, b.board_id, { canUseMemberWorkspaceServices: true })
        )
      );
    });
    expect(['s-1', 's-2', 's-3'].every((id) => agorStore.getState().sessionById.has(id))).toBe(
      true
    );

    // Disconnected: another user archives s-2, and board-3's branch is revoked.
    rerender({ connected: false });
    server.sessions = [session(1), { ...session(2), archived: true }];
    server.branches = [theirs(1), theirs(2)];
    rerender({ connected: true });
    await waitFor(() => {
      const state = agorStore.getState();
      expect(state.sessionById.has('s-2')).toBe(false);
      expect(state.sessionById.has('s-3')).toBe(false);
      expect(state.branchById.has('b-3')).toBe(false);
    });
  });
});

describe('useAgorData — a branch moved back onto a loaded board', () => {
  it("restores another user's sessions it lost while on an unloaded board", async () => {
    window.history.pushState({}, '', '/b/board-one/');
    onTestFinished(() => window.history.pushState({}, '', '/'));
    const board = { board_id: 'board-1', slug: 'board-one', name: 'Board one' };
    const theirs = makeBranch({ branch_id: 'b-x', board_id: 'board-1', created_by: 'user-b' });
    const server = {
      branches: [theirs as Row],
      sessions: [makeSession({ session_id: 's-x', branch_id: 'b-x', created_by: 'user-b' }) as Row],
    };
    const { client, emit } = makeMockClient(
      fakeServer({ boards: [board], 'boards:get': board as never }, server)
    );
    const { result } = renderHook(() => {
      const data = useAgorData(client, {
        authenticatedUserId: 'user-a',
        authenticatedUserRole: 'member',
        authGeneration: 1,
        connectionReady: true,
      });
      useBoardPartition(client, 'board-1', { canUseMemberWorkspaceServices: true });
      return data;
    });
    await waitForInitialLoad(result);
    await flush();
    expect(agorStore.getState().sessionById.has('s-x')).toBe(true);

    // Moved to a board that isn't loaded: nothing holds the branch or its session.
    const away = { ...theirs, board_id: 'board-2' };
    server.branches = [away];
    act(() => emit('branches', 'patched', away));
    expect(agorStore.getState().branchById.has('b-x')).toBe(false);
    expect(agorStore.getState().sessionById.has('s-x')).toBe(false);

    // Moved back: a branch move emits no session events, yet the board must
    // not claim to be complete without the session.
    server.branches = [theirs];
    act(() => emit('branches', 'patched', theirs));
    expect(agorStore.getState().branchById.has('b-x')).toBe(true);
    await waitFor(() => {
      const state = agorStore.getState();
      expect(state.sessionById.has('s-x')).toBe(true);
      expect(state.sessionsByBranch.get('b-x')?.map((s) => s.session_id)).toEqual(['s-x']);
      expect(makeBoardReadySelector('board-1')(state)).toBe(true);
    });
    expect(
      selectBoardPartition(agorStore.getState(), 'board-1')?.members?.sessions?.has('s-x')
    ).toBe(true);
  });
});

describe('useAgorData — navigating while a reconnect resync runs', () => {
  it('the destination board still loads while the resync runs', async () => {
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

    // The resync finishes, then B's first read lands.
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
      expect(selectBoardPartition(agorStore.getState(), 'board-b')?.status).toBe('loaded')
    );
    // B's read started after the resync began, so the resync kept it: one read.
    expect(bReads).toBe(1);
  });

  it('keeps every board loaded during the resync loaded, each read once', async () => {
    window.history.pushState({}, '', '/b/board-a/');
    onTestFinished(() => window.history.pushState({}, '', '/'));
    const boardA = { board_id: 'board-a', slug: 'board-a', name: 'A' };
    const boardB = { board_id: 'board-b', slug: 'board-b', name: 'B' };
    const boardC = { board_id: 'board-c', slug: 'board-c', name: 'C' };
    const seed: Record<string, unknown> = {
      boards: [boardA, boardB, boardC],
      'boards:get': boardA,
    };
    const { client, emitIo, onFetch, fetchArguments } = makeMockClient(seed as never);
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
    const reads = (boardId: string) =>
      fetchArguments('cards', 'findAll').filter(
        (args) => (args as { query?: { board_id?: string } }).query?.board_id === boardId
      ).length;
    const partition = (boardId: string) => selectBoardPartition(agorStore.getState(), boardId);

    // Hold the resync in its board-scoped batch (A is already resolved).
    const resync = deferred();
    onFetch('board-comments', 'findAll', (call) => (call === 2 ? resync.promise : undefined));
    act(() => emitIo('connect'));
    await flush();

    // Open B, then C, while the resync is held: each loads in full.
    for (const board of [boardB, boardC]) {
      seed['boards:get'] = { ...board, objects: { z: { type: 'zone' } } };
      window.history.pushState({}, '', `/b/${board.slug}/`);
      rerender({ boardId: board.board_id });
      await waitFor(() => expect(partition(board.board_id)?.status).toBe('loaded'));
    }

    await act(async () => {
      resync.resolve();
      await resync.promise;
    });
    await flush();
    await waitFor(() => expect(partition('board-a')?.status).toBe('loaded'));
    await flush();
    for (const boardId of ['board-b', 'board-c']) {
      expect(partition(boardId)?.status).toBe('loaded');
      expect(reads(boardId)).toBe(1);
      // The resync's lean board list does not replace their full records.
      expect(agorStore.getState().boardById.get(boardId)?.objects).toBeDefined();
    }
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
        expect(selectBoardPartition(agorStore.getState(), 'board-b')?.status).toBe('loaded')
      );
      await flush();
      // One read of B's annotations: the resync reused B's in-flight load.
      expect(boardReads('cards')).toBe(1);
      expect(boardReads('board-objects')).toBe(1);
      expect(selectBoardPartition(agorStore.getState(), 'board-b')?.status).toBe('loaded');
    }
  );
});

describe('branch creation on an already-open board', () => {
  // The services are independently authorized/published, so readiness and
  // placement may overtake the branch create. No order needs a refresh.
  it.each([
    ['branch', 'placement', 'ready'],
    ['branch', 'ready', 'placement'],
    ['placement', 'branch', 'ready'],
    ['placement', 'ready', 'branch'],
    ['ready', 'branch', 'placement'],
    ['ready', 'placement', 'branch'],
  ])('keeps one placed, ready card for %s -> %s -> %s', async (...order) => {
    const { client, emit, fetchCount } = makeMockClient(onBoardRoute({}));
    const { result, unmount } = renderHook(() => useAgorData(client));
    try {
      await waitForInitialLoad(result);
      const select = makeBranchesForBoardSelector('board-1');
      expect(select(agorStore.getState())).toEqual([]);
      const beforeBranches = fetchCount('branches', 'findAll');
      const beforePlacements = fetchCount('board-objects', 'findAll');
      const branch = makeBranch({ board_id: 'board-1', filesystem_status: 'creating' });
      const ready = { ...branch, filesystem_status: 'ready' };
      const placement = makeBoardObject({ zone_id: 'zone-tasks' });
      const events: Record<string, () => void> = {
        branch: () => emit('branches', 'created', branch),
        placement: () => emit('board-objects', 'created', placement),
        ready: () => emit('branches', 'patched', ready),
      };
      for (const event of order) act(events[event]);
      // Delayed/replayed creates must not roll back ready state or duplicate
      // a placement. Branch updates do not carry the board-object record.
      act(events.branch);
      act(events.placement);
      expect(select(agorStore.getState())).toEqual([ready]);
      expect(agorStore.getState().boardObjectsByBoardId.get('board-1')).toEqual([placement]);
      const moved = { ...placement, position: { x: 80, y: 120 }, zone_id: 'zone-review' };
      act(() => emit('board-objects', 'patched', moved));
      act(events.placement); // old create cannot undo newer placement
      act(events.ready); // readiness never replaces placement
      expect(agorStore.getState().boardObjectsByBoardId.get('board-1')).toEqual([moved]);
      expect(select(agorStore.getState())).toHaveLength(1);
      expect(fetchCount('branches', 'findAll')).toBe(beforeBranches);
      expect(fetchCount('board-objects', 'findAll')).toBe(beforePlacements);
    } finally {
      unmount();
    }
  });
});

describe('useAgorData — scoped reconnect', () => {
  const boardA = { board_id: 'board-A', slug: 'displayed', name: 'Displayed' };
  const authenticated = {
    authenticatedUserId: 'user-me',
    authenticatedUserRole: 'member',
    authGeneration: 1,
    connectionReady: true,
  } as const;

  const mate = (overrides: Record<string, unknown>) =>
    makeBranch({ custom_context: { teammate: { kind: 'teammate' } }, ...overrides });

  /** Every user scope and the displayed board loaded, then rows changed while disconnected. */
  function workspace() {
    const server = {
      branches: [
        makeBranch({ branch_id: 'b-A', board_id: 'board-A', created_by: 'user-other' }),
        makeBranch({ branch_id: 'b-A-del', board_id: 'board-A', created_by: 'user-other' }),
        makeBranch({ branch_id: 'b-A-moved', board_id: 'board-A', created_by: 'user-other' }),
        makeBranch({ branch_id: 'b-mine', board_id: 'board-C', created_by: 'user-me' }),
        makeBranch({ branch_id: 'b-mine-del', board_id: 'board-C', created_by: 'user-me' }),
        makeBranch({ branch_id: 'b-mine-A', board_id: 'board-A', created_by: 'user-me' }),
        mate({ branch_id: 'mate-1', board_id: 'board-D', created_by: 'user-other' }),
        mate({ branch_id: 'mate-unmarked', board_id: 'board-D', created_by: 'user-other' }),
        makeBranch({ branch_id: 'b-ref', board_id: 'board-E', created_by: 'user-other' }),
        makeBranch({ branch_id: 'b-ref-keep', board_id: 'board-E', created_by: 'user-other' }),
      ] as Row[],
      sessions: [
        makeSession({ session_id: 's-A', branch_id: 'b-A', created_by: 'user-other' }),
        makeSession({ session_id: 's-A-arch', branch_id: 'b-A', created_by: 'user-other' }),
        makeSession({ session_id: 's-mine', branch_id: 'b-mine', created_by: 'user-me' }),
        makeSession({ session_id: 's-mine-arch', branch_id: 'b-mine', created_by: 'user-me' }),
        makeSession({ session_id: 's-mine-A', branch_id: 'b-A', created_by: 'user-me' }),
        makeSession({ session_id: 's-ref', branch_id: 'b-ref', created_by: 'user-me' }),
        makeSession({ session_id: 's-ref-keep', branch_id: 'b-ref-keep', created_by: 'user-me' }),
      ] as Row[],
    };
    const disconnect = () => {
      const archive = new Set(['s-A-arch', 's-mine-arch']);
      server.sessions = server.sessions.map((row) =>
        archive.has(row.session_id as string) ? { ...row, archived: true } : row
      );
      server.branches = server.branches
        .filter((row) => row.branch_id !== 'b-A-del' && row.branch_id !== 'b-mine-del')
        .map((row) => {
          switch (row.branch_id) {
            case 'b-A-moved':
            case 'b-mine-A':
              return { ...row, board_id: 'board-C' };
            case 'mate-unmarked':
              return { ...row, custom_context: {} };
            case 'b-ref':
              return { ...row, archived: true };
            case 'b-ref-keep':
              return { ...row, name: 'renamed' };
            default:
              return row;
          }
        });
    };
    return { server, disconnect };
  }

  async function connectedWorkspace(server: ReturnType<typeof workspace>['server']) {
    window.history.pushState({}, '', '/b/displayed/');
    onTestFinished(() => window.history.pushState({}, '', '/'));
    const seed = fakeServer({ boards: [boardA], 'boards:get': boardA as never }, server);
    const mock = makeMockClient(seed);
    const hook = renderHook(
      ({ generation }) =>
        useAgorData(mock.client, { ...authenticated, authGeneration: generation }),
      { initialProps: { generation: 1 } }
    );
    await waitForInitialLoad(hook.result);
    await waitFor(() => {
      const state = agorStore.getState();
      expect(selectMySessionsLoaded(state)).toBe(true);
      expect(selectTeammatesLoaded(state)).toBe(true);
      expect(selectHomeBranchesLoaded(state)).toBe(true);
    });
    await flush();
    return { ...mock, ...hook, seed };
  }

  const resyncs = {
    'socket reconnect': (emitIo: (event: string) => void) => act(() => emitIo('connect')),
    'authority change': (_emitIo: unknown, rerender: (props: { generation: number }) => void) =>
      rerender({ generation: 2 }),
  };

  for (const [name, resync] of Object.entries(resyncs)) {
    it(`after a ${name}, every user scope and the displayed board reconcile without global reads`, async () => {
      const { server, disconnect } = workspace();
      const { emitIo, rerender, fetchArguments } = await connectedWorkspace(server);
      const has = (map: 'sessionById' | 'branchById', id: string) =>
        agorStore.getState()[map].has(id);
      const loaded = [...server.sessions, ...server.branches].every((row) =>
        has(
          row.session_id ? 'sessionById' : 'branchById',
          (row.session_id ?? row.branch_id) as string
        )
      );
      expect(loaded).toBe(true);
      markBoardLoaded('board-B');
      const boardReads = () =>
        [...fetchArguments('branches', 'findAll'), ...fetchArguments('sessions', 'findAll')].length;
      const before = boardReads();

      disconnect();
      resync(emitIo, rerender);
      await waitFor(() => expect(has('sessionById', 's-mine-arch')).toBe(false));
      await waitFor(() => expect(has('branchById', 'b-ref')).toBe(false));
      await flush();

      const state = agorStore.getState();
      // Deleted, archived and moved off the displayed board.
      for (const id of ['s-A-arch', 's-mine-arch']) expect(has('sessionById', id)).toBe(false);
      for (const id of ['b-A-del', 'b-A-moved', 'b-mine-del', 'mate-unmarked', 'b-ref']) {
        expect(has('branchById', id)).toBe(false);
      }
      expect(state.absentBranchIds.has('b-ref')).toBe(true);
      // Kept, refreshed from the server.
      for (const id of ['s-A', 's-mine', 's-mine-A', 's-ref', 's-ref-keep']) {
        expect(has('sessionById', id)).toBe(true);
      }
      for (const id of ['b-A', 'b-mine', 'mate-1']) expect(has('branchById', id)).toBe(true);
      expect(state.branchById.get('b-ref-keep')?.name).toBe('renamed');
      // Moved off the displayed board, but still mine: my branches hold it.
      expect(state.branchById.get('b-mine-A')?.board_id).toBe('board-C');
      // The displayed board is loaded again; the other board is unloaded and not read.
      expect(selectBoardPartition(state, 'board-A')?.status).toBe('loaded');
      expect(state.coverage.has(boardScopeKey('board-B'))).toBe(false);
      expect(
        [...fetchArguments('branches', 'findAll'), ...fetchArguments('sessions', 'findAll')]
          .slice(before)
          .map((args) => (args as { query: Record<string, unknown> }).query.board_id)
          .filter((boardId) => boardId && boardId !== 'board-A')
      ).toEqual([]);
      expect(boardReads()).toBeGreaterThan(before);
      expect(selectMySessionsLoaded(state)).toBe(true);
      expect(selectTeammatesLoaded(state)).toBe(true);
      expect(selectHomeBranchesLoaded(state)).toBe(true);
      for (const reads of [
        fetchArguments('sessions', 'findAll'),
        fetchArguments('sessions', 'find'),
        fetchArguments('branches', 'findAll'),
        fetchArguments('branches', 'find'),
      ]) {
        expect(globalReads(reads)).toEqual([]);
      }
    });
  }

  it('a capped teammate read removes nothing on reconnect', async () => {
    const { server, disconnect } = workspace();
    const { emitIo, seed } = await connectedWorkspace(server);
    // The teammate read now reports more teammates than it returned.
    const find = seed['branches:find'] as unknown as (query: Record<string, unknown>) => {
      data: Row[];
      total: number;
    };
    seed['branches:find'] = ((query: Record<string, unknown>) => {
      const page = find(query);
      return query.teammate ? { ...page, total: page.total + 5_000 } : page;
    }) as never;

    disconnect();
    act(() => emitIo('connect'));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-mine-del')).toBe(false));
    await flush();
    const state = agorStore.getState();
    expect(selectTeammatesTruncated(state)).toBe(true);
    // Unmarked, but the capped read can't prove it: it stays.
    expect(state.branchById.has('mate-unmarked')).toBe(true);
    expect(state.branchById.has('mate-1')).toBe(true);
  });

  it("a board opened earlier doesn't keep another user's rows deleted while disconnected", async () => {
    const { server } = workspace();
    const other = (id: string) =>
      makeBranch({ branch_id: id, board_id: 'board-B', created_by: 'user-other' });
    const otherSession = (id: string, branchId: string) =>
      makeSession({ session_id: id, branch_id: branchId, created_by: 'user-other' });
    server.branches.push(other('b-B'), other('b-B-gone') as Row);
    server.sessions.push(otherSession('s-B', 'b-B'), otherSession('s-B-gone', 'b-B') as Row);
    const { emitIo, client } = await connectedWorkspace(server);
    const has = (map: 'sessionById' | 'branchById', id: string) =>
      agorStore.getState()[map].has(id);
    // Open board B, then go back to board A (displayed): B stays among the recent partitions.
    const releaseB = registerBoardUse('board-B');
    await act(() => loadBoardPartition(client, 'board-B', { canUseMemberWorkspaceServices: true }));
    releaseB();
    expect(selectBoardPartition(agorStore.getState(), 'board-B')?.status).toBe('loaded');
    for (const id of ['b-B', 'b-B-gone']) expect(has('branchById', id)).toBe(true);
    for (const id of ['s-B', 's-B-gone']) expect(has('sessionById', id)).toBe(true);

    // While disconnected, another user's branch is deleted and a session revoked.
    server.branches = server.branches.filter((row) => row.branch_id !== 'b-B-gone');
    server.sessions = server.sessions.filter((row) => row.session_id !== 's-B-gone');
    act(() => emitIo('connect'));
    await waitFor(() => expect(has('branchById', 'b-B-gone')).toBe(false));
    await flush();
    // B is unloaded and none of its rows stay; the displayed board's do.
    expect(agorStore.getState().coverage.has(boardScopeKey('board-B'))).toBe(false);
    for (const id of ['s-B', 's-B-gone']) expect(has('sessionById', id)).toBe(false);
    expect(has('branchById', 'b-B')).toBe(false);
    expect(has('branchById', 'b-A')).toBe(true);
    // Re-opening B reads it again, without the deleted rows.
    await act(() => loadBoardPartition(client, 'board-B', { canUseMemberWorkspaceServices: true }));
    expect(has('branchById', 'b-B')).toBe(true);
    expect(has('sessionById', 's-B')).toBe(true);
    expect(has('branchById', 'b-B-gone')).toBe(false);
    expect(has('sessionById', 's-B-gone')).toBe(false);
  });

  it('a scope of the earlier lifetime holds its rows until the resync settles, then releases them', async () => {
    const { server } = workspace();
    const { rerender, seed } = await connectedWorkspace(server);
    const has = (id: string) => agorStore.getState().branchById.has(id);
    // mate-1 (board D, unloaded, someone else's) is held only by the teammate read.
    expect(has('mate-1')).toBe(true);
    // On the resync the teammate read fails: its piece stays from the earlier lifetime.
    const find = seed['branches:find'] as unknown as (query: Record<string, unknown>) => unknown;
    seed['branches:find'] = ((query: Record<string, unknown>) => {
      if (query.teammate) throw new Error('teammates unavailable');
      return find(query);
    }) as never;
    // A new authority generation: a new lifetime, every scope replaced.
    rerender({ generation: 2 });
    await waitFor(() => expect(has('mate-1')).toBe(false));
    await flush();
    const state = agorStore.getState();
    expect(state.coverage.has(USER_SCOPE_KEYS.teammates)).toBe(false);
    expect(selectTeammatesLoaded(state)).toBe(false);
    // The pieces the reconnect replaced keep theirs.
    expect(has('b-mine')).toBe(true);
    expect(state.sessionById.has('s-mine')).toBe(true);
  });

  it('a piece a plain reconnect fails to replace is retired once the resync settles', async () => {
    const { server } = workspace();
    const { emitIo, seed } = await connectedWorkspace(server);
    const has = (id: string) => agorStore.getState().branchById.has(id);
    expect(has('mate-1')).toBe(true);
    const find = seed['branches:find'] as unknown as (query: Record<string, unknown>) => unknown;
    seed['branches:find'] = ((query: Record<string, unknown>) => {
      if (query.teammate) throw new Error('teammates unavailable');
      return find(query);
    }) as never;
    // Same authority and lifetime: only the run's generation tells the pieces apart.
    act(() => emitIo('connect'));
    await waitFor(() => expect(has('mate-1')).toBe(false));
    await flush();
    const state = agorStore.getState();
    expect(state.coverage.has(USER_SCOPE_KEYS.teammates)).toBe(false);
    expect(selectTeammatesLoaded(state)).toBe(false);
    // The replaced pieces stay loaded with their rows.
    expect(selectMySessionsLoaded(state)).toBe(true);
    expect(has('b-mine')).toBe(true);
    expect(state.sessionById.has('s-mine')).toBe(true);
  });
});

describe('useAgorData — recent-board preload', () => {
  const boards = [1, 2, 3, 4, 5].map((n) => ({
    board_id: `board-${n}`,
    slug: `board-${n}`,
    name: `Board ${n}`,
  }));
  const ids = boards.map((board) => board.board_id);
  type Props = { generation: number; role: string };

  /** On board-1's route (displayed), with `visited` boards in the history, most recent first. */
  function workspace(visited: string[] = ids, seed: Record<string, unknown[]> = {}) {
    window.history.pushState({}, '', '/b/board-1/');
    if (visited.length) {
      localStorage.setItem(recentBoardsStorageKey('user-me'), JSON.stringify(visited));
    }
    onTestFinished(() => {
      window.history.pushState({}, '', '/');
      localStorage.removeItem(recentBoardsStorageKey('user-me'));
    });
    const mock = makeMockClient({
      boards,
      'boards:get': ((id: string) => boards.find((board) => board.board_id === id)) as never,
      ...seed,
    });
    const query = (call: number) =>
      (mock.fetchArguments('branches', 'findAll')[call - 1] as { query: Record<string, unknown> })
        .query;
    const boardReads = (boardId: string) =>
      mock
        .fetchArguments('branches', 'findAll')
        .filter((args) => (args as { query: { board_id?: string } }).query.board_id === boardId)
        .length;
    const hook = renderHook(
      ({ generation, role }: Props) => {
        const data = useAgorData(mock.client, {
          authenticatedUserId: 'user-me',
          authenticatedUserRole: role,
          authGeneration: generation,
          connectionReady: true,
        });
        useBoardPartition(mock.client, 'board-1', { canUseMemberWorkspaceServices: true });
        return data;
      },
      { initialProps: { generation: 1, role: 'member' } }
    );
    return { ...mock, ...hook, query, boardReads };
  }
  const status = (boardId: string) => selectBoardPartition(agorStore.getState(), boardId)?.status;
  const scopeSettled = () => {
    const state = agorStore.getState();
    return selectMySessionsLoaded(state) && selectHomeBranchesLoaded(state);
  };

  it('loads the three most recent other boards once the user scope settles, one at a time, behind foreground reads', async () => {
    const foreground = deferred();
    holdBackgroundReads(foreground.promise);
    const gates = new Map(ids.map((id) => [id, deferred()]));
    const { result, onFetch, query, boardReads } = workspace();
    onFetch('branches', 'findAll', (call) => {
      const boardId = query(call).board_id as string | undefined;
      return boardId && boardId !== 'board-1' ? gates.get(boardId)!.promise : undefined;
    });
    await waitForInitialLoad(result);
    await waitFor(() => expect(scopeSettled()).toBe(true));
    await flush();
    // Held behind the foreground read.
    expect(ids.map(boardReads)).toEqual([1, 0, 0, 0, 0]);

    await act(async () => foreground.resolve());
    await waitFor(() => expect(boardReads('board-2')).toBe(1));
    await flush();
    expect(ids.map(boardReads)).toEqual([1, 1, 0, 0, 0]);
    await act(async () => gates.get('board-2')!.resolve());
    await waitFor(() => expect(boardReads('board-3')).toBe(1));
    await flush();
    expect(ids.map(boardReads)).toEqual([1, 1, 1, 0, 0]);
    await act(async () => gates.get('board-3')!.resolve());
    await waitFor(() => expect(boardReads('board-4')).toBe(1));
    await act(async () => gates.get('board-4')!.resolve());
    await waitFor(() => expect(status('board-4')).toBe('loaded'));
    await flush();
    // At most RETAINED_BACKGROUND_PARTITIONS: board-5 is never read, nothing evicted.
    expect(ids.map(boardReads)).toEqual([1, 1, 1, 1, 0]);
    expect(ids.map(status)).toEqual(['loaded', 'loaded', 'loaded', 'loaded', undefined]);
  });

  it('opens a preloaded board ready at once, with no read', async () => {
    const { result, client, fetchCount } = workspace();
    await waitForInitialLoad(result);
    await waitFor(() => expect(status('board-4')).toBe('loaded'));
    await flush();
    const reads = () =>
      [
        fetchCount('branches', 'findAll'),
        fetchCount('sessions', 'findAll'),
        fetchCount('cards', 'findAll'),
        fetchCount('board-objects', 'findAll'),
        fetchCount('boards', 'get'),
      ].join();
    const before = reads();

    const opened = renderHook(() =>
      useBoardPartition(client, 'board-3', { canUseMemberWorkspaceServices: true })
    );
    expect(opened.result.current.boardReady).toBe(true);
    await flush();
    expect(reads()).toBe(before);
    opened.unmount();
  });

  it('preloads nothing before the user scope settles', async () => {
    const myBranches = deferred();
    const { result, onFetch, query, boardReads } = workspace();
    onFetch('branches', 'findAll', (call) =>
      query(call).created_by ? myBranches.promise : undefined
    );
    await waitForInitialLoad(result);
    await flush();
    expect(scopeSettled()).toBe(false);
    expect(ids.slice(1).map(boardReads)).toEqual([0, 0, 0, 0]);

    await act(async () => myBranches.resolve());
    await waitFor(() => expect(status('board-4')).toBe('loaded'));
  });

  it('without visit history, preloads the boards of my latest sessions, as Home lists them', async () => {
    // A fresh browser: no visit history. Home falls back to my sessions' boards.
    const mine = (id: string, boardId: string, at: string) =>
      makeSession({
        session_id: id,
        branch_id: `br-${boardId}`,
        branch_board_id: boardId,
        created_by: 'user-me',
        last_updated: at,
      });
    const { result, boardReads } = workspace([], {
      'sessions:find': [
        mine('s-1', 'board-1', '2026-01-06T00:00:00Z'),
        mine('s-3', 'board-3', '2026-01-02T00:00:00Z'),
        mine('s-5', 'board-5', '2026-01-03T00:00:00Z'),
        mine('s-2', 'board-2', '2026-01-04T00:00:00Z'),
        mine('s-4', 'board-4', '2026-01-05T00:00:00Z'),
      ],
    });
    await waitForInitialLoad(result);
    await waitFor(() => expect(status('board-5')).toBe('loaded'));
    await flush();
    // Most recent first (board-1 is displayed): board-4, board-2, board-5.
    expect(ids.map(boardReads)).toEqual([1, 1, 0, 1, 1]);
    expect(ids.map(status)).toEqual(['loaded', 'loaded', undefined, 'loaded', 'loaded']);
  });

  it('preloads again once after each reconnect resync settles, never more', async () => {
    const { result, emitIo, rerender, boardReads } = workspace();
    await waitForInitialLoad(result);
    await waitFor(() => expect(status('board-4')).toBe('loaded'));
    await flush();
    expect(ids.map(boardReads)).toEqual([1, 1, 1, 1, 0]);

    // A socket reconnect resync unloads the preloaded boards; they load again once.
    act(() => emitIo('connect'));
    await waitFor(() => expect(boardReads('board-4')).toBe(2));
    await waitFor(() => expect(status('board-4')).toBe('loaded'));
    await flush();
    expect(ids.slice(1).map(boardReads)).toEqual([2, 2, 2, 0]);

    // A new auth generation (the app's reconnect) unloads every partition: once more.
    rerender({ generation: 2, role: 'member' });
    await waitFor(() => expect(boardReads('board-4')).toBe(3));
    await waitFor(() => expect(status('board-4')).toBe('loaded'));
    await flush();
    expect(ids.slice(1).map(boardReads)).toEqual([3, 3, 3, 0]);
    expect(ids.map(status)).toEqual(['loaded', 'loaded', 'loaded', 'loaded', undefined]);
  });
});
