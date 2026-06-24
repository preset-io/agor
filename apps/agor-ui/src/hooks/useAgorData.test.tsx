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
 * contract: if an event doesn't change byId content, the hook return
 * shape is reference-stable.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
  // Synchronous side effects fired at call time of `service(name)[method]()` —
  // used by the skip-apply-on-race tests to inject a live write mid-fetch.
  const fetchHooks = new Map<string, (call: number) => void>();
  const fetchCounts = new Map<string, number>();

  const respond = (name: string, method: 'findAll' | 'find') => {
    const key = `${name}:${method}`;
    const call = (fetchCounts.get(key) ?? 0) + 1;
    fetchCounts.set(key, call);
    fetchHooks.get(key)?.(call);
    const data = seed[key] ?? seed[name] ?? [];
    return Promise.resolve(data);
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
    // Register a synchronous side effect that runs every time `service(name)`'s
    // `method` is invoked (receives the 1-based call count). The hook fires
    // BEFORE the returned promise resolves, so emitting a live event here lands
    // a write DURING the fetch window — exactly the race the hydration guards.
    onFetch: (name: string, method: 'findAll' | 'find', fn: (call: number) => void) =>
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

    expect(result.current.sessionById.get('s-archived-full')).toMatchObject({
      archived: true,
      branch_id: 'b-archived',
    });
    expect(result.current.sessionsByBranch.has('b-archived')).toBe(false);
    expect(result.current.branchById.has('b-archived')).toBe(false);
  });

  it('drops a duplicate `sessions.patched` (content-equal) without changing byId references', async () => {
    const session = makeSession();
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeSessions = result.current.sessionById;
    const beforeByBranch = result.current.sessionsByBranch;

    // Feathers re-emits a fresh object on every patch — same content,
    // different reference. The hook MUST bail out (no-op patch).
    act(() => emit('sessions', 'patched', { ...session }));

    expect(result.current.sessionById).toBe(beforeSessions);
    expect(result.current.sessionsByBranch).toBe(beforeByBranch);
  });

  it('updates byId references when a session field actually changes', async () => {
    const session = makeSession({ status: 'idle' });
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeSessions = result.current.sessionById;

    act(() => emit('sessions', 'patched', { ...session, status: 'running' }));

    expect(result.current.sessionById).not.toBe(beforeSessions);
    expect(result.current.sessionById.get('s-1')).toMatchObject({ status: 'running' });
  });

  it('updates branch-card session buckets when stop patches a running session idle', async () => {
    const session = makeSession({ status: 'running', ready_for_prompt: false });
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    act(() =>
      emit('sessions', 'patched', {
        ...session,
        status: 'idle',
        ready_for_prompt: true,
      })
    );

    expect(result.current.sessionById.get('s-1')).toMatchObject({
      status: 'idle',
      ready_for_prompt: true,
    });
    expect(result.current.sessionsByBranch.get('b-1')?.[0]).toMatchObject({
      status: 'idle',
      ready_for_prompt: true,
    });
  });

  it('ignores `sessions.removed` for a session not in the map', async () => {
    const { client, emit } = makeMockClient();
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeSessions = result.current.sessionById;
    const beforeByBranch = result.current.sessionsByBranch;

    act(() => emit('sessions', 'removed', makeSession({ session_id: 'unknown' })));

    expect(result.current.sessionById).toBe(beforeSessions);
    expect(result.current.sessionsByBranch).toBe(beforeByBranch);
  });

  it('drops a no-op `branches.patched` (idempotent content)', async () => {
    const branch = makeBranch();
    const { client, emit } = makeMockClient({ branches: [branch] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const before = result.current.branchById;
    act(() => emit('branches', 'patched', { ...branch }));
    expect(result.current.branchById).toBe(before);
  });

  it('updates branchById when a branch field flips', async () => {
    const branch = makeBranch({ name: 'main' });
    const { client, emit } = makeMockClient({ branches: [branch] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const before = result.current.branchById;
    act(() => emit('branches', 'patched', { ...branch, name: 'feature/x' }));

    expect(result.current.branchById).not.toBe(before);
    expect(result.current.branchById.get('b-1')?.name).toBe('feature/x');
  });

  it('drops a duplicate `sessions.created` for an existing id', async () => {
    const session = makeSession();
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeSessions = result.current.sessionById;
    const beforeByBranch = result.current.sessionsByBranch;

    act(() => emit('sessions', 'created', { ...session }));

    expect(result.current.sessionById).toBe(beforeSessions);
    expect(result.current.sessionsByBranch).toBe(beforeByBranch);
  });

  it('keeps unrelated byId maps reference-stable across a session patch', async () => {
    const session = makeSession({ status: 'idle' });
    const branch = makeBranch();
    const { client, emit } = makeMockClient({ sessions: [session], branches: [branch] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    const beforeBranches = result.current.branchById;
    const beforeBoards = result.current.boardById;
    const beforeUsers = result.current.userById;

    act(() => emit('sessions', 'patched', { ...session, status: 'running' }));

    // Only sessionById / sessionsByBranch flip — the rest must stay put so
    // their consumers (SessionCanvas, boards UI, user settings) don't
    // needlessly re-render.
    expect(result.current.branchById).toBe(beforeBranches);
    expect(result.current.boardById).toBe(beforeBoards);
    expect(result.current.userById).toBe(beforeUsers);
  });

  it('migrates a session between branches when branch_id changes', async () => {
    const session = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const { client, emit } = makeMockClient({ sessions: [session] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(result.current.sessionsByBranch.get('b-1')?.map((s) => s.session_id)).toEqual(['s-1']);

    act(() => emit('sessions', 'patched', { ...session, branch_id: 'b-2' }));

    // Old branch bucket is cleaned up; new branch bucket holds the session.
    expect(result.current.sessionsByBranch.has('b-1')).toBe(false);
    expect(result.current.sessionsByBranch.get('b-2')?.map((s) => s.session_id)).toEqual(['s-1']);
    expect(result.current.sessionById.get('s-1')?.branch_id).toBe('b-2');
  });

  it('evicts a branch and its sessions on `branches.removed`', async () => {
    const session = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const branch = makeBranch({ branch_id: 'b-1' });
    const { client, emit } = makeMockClient({ sessions: [session], branches: [branch] });
    const { result } = renderHook(() => useAgorData(client));
    await waitForInitialLoad(result);

    expect(result.current.branchById.has('b-1')).toBe(true);
    expect(result.current.sessionById.has('s-1')).toBe(true);
    expect(result.current.sessionsByBranch.has('b-1')).toBe(true);

    act(() => emit('branches', 'removed', branch));

    expect(result.current.branchById.has('b-1')).toBe(false);
    expect(result.current.sessionById.has('s-1')).toBe(false);
    expect(result.current.sessionsByBranch.has('b-1')).toBe(false);
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
      expect(result.current.artifactById.get('a-1')?.content_hash).toBe('h2');
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

    const before = result.current.artifactById;

    act(() => emit('artifacts', 'patched', { ...artifact }));

    expect(result.current.artifactById).toBe(before);
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

    expect(result.current.boardObjectById.get('bo-branch')).toMatchObject({ branch_id: 'b-1' });
    expect(result.current.boardObjectsByBoardId.get('board-1')?.map((bo) => bo.object_id)).toEqual([
      'bo-branch',
      'bo-card',
    ]);
    expect(result.current.boardObjectsByBoardId.get('board-2')?.map((bo) => bo.object_id)).toEqual([
      'bo-other',
    ]);
    expect(result.current.boardObjectByBranchId.get('b-1')?.object_id).toBe('bo-branch');
    expect(result.current.boardObjectByCardId.get('c-1')?.object_id).toBe('bo-card');
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

    expect(result.current.boardObjectsByBoardId.has('board-1')).toBe(false);
    expect(result.current.boardObjectsByBoardId.get('board-2')?.map((bo) => bo.object_id)).toEqual([
      'bo-1',
    ]);
    expect(result.current.boardObjectByBranchId.has('b-1')).toBe(false);
    expect(result.current.boardObjectByBranchId.get('b-2')?.zone_id).toBe('zone-b');

    act(() => emit('board-objects', 'removed', { ...boardObject, board_id: 'board-2' }));

    expect(result.current.boardObjectById.has('bo-1')).toBe(false);
    expect(result.current.boardObjectsByBoardId.has('board-2')).toBe(false);
    expect(result.current.boardObjectByBranchId.has('b-2')).toBe(false);
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

    const beforeCurrentBoardBucket = result.current.boardObjectsByBoardId.get('board-1');

    act(() =>
      emit('board-objects', 'patched', {
        ...otherBoardObject,
        zone_id: 'zone-on-other-board',
      })
    );

    expect(result.current.boardObjectsByBoardId.get('board-1')).toBe(beforeCurrentBoardBucket);
    expect(result.current.boardObjectsByBoardId.get('board-2')?.[0]?.zone_id).toBe(
      'zone-on-other-board'
    );
  });
});

/**
 * Background hydration uses a "skip-apply-on-race" rule (see `runHydration` /
 * `liveRevisionsRef` in useAgorData.ts): the full-set snapshot is applied
 * WHOLESALE only when no live write to the target collection raced the fetch.
 * If one did, the snapshot is discarded and refetched — never overlaid — and if
 * the race never settles the apply is skipped entirely. These tests pin that
 * contract (apply-on-quiet, retry-on-race, skip-without-resurrect, and
 * per-collection independence) using `onFetch` to land a live write mid-fetch.
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

    expect(result.current.sessionById.has('s-1')).toBe(true);
    // s-2 was absent from first paint and only arrives via the hydration.
    expect(result.current.sessionById.has('s-2')).toBe(true);
    expect(result.current.branchById.has('b-1')).toBe(true);
    expect(
      result.current.sessionsByBranch
        .get('b-1')
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
    expect(result.current.sessionById.has('s-3')).toBe(true);
    expect(result.current.sessionById.has('s-2')).toBe(true);
  });

  it('skips the apply when the race never settles, so a removed session is not resurrected', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const { client, emit, onFetch, fetchCount } = makeMockClient({
      'sessions:find': [s1, s2],
      // The snapshot ALWAYS still contains s-2 (stale backend): if it were ever
      // applied it would resurrect the removed session.
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
    // Every attempt races → 4 immediate + 2 backoff = 6 fetches, then skip.
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBe(6), { timeout: 4000 });

    expect(result.current.sessionById.has('s-1')).toBe(true);
    // The stale snapshot was never applied, so s-2 stays removed.
    expect(result.current.sessionById.has('s-2')).toBe(false);
  });

  it('hydrates an unrelated collection even while another keeps racing (per-collection revisions)', async () => {
    const s1 = makeSession({ session_id: 's-1', branch_id: 'b-1' });
    const s2 = makeSession({ session_id: 's-2', branch_id: 'b-1' });
    const m1 = { mcp_server_id: 'm-1', name: 'one' };
    const m2 = { mcp_server_id: 'm-2', name: 'two' };
    const { client, emit, onFetch, fetchCount } = makeMockClient({
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
    await waitFor(() => expect(fetchCount('sessions', 'findAll')).toBe(6), { timeout: 4000 });

    // …the mcp-servers hydration is independent of `sessions`, so it applied.
    expect(result.current.mcpServerById.has('m-1')).toBe(true);
    expect(result.current.mcpServerById.has('m-2')).toBe(true);
    // …while the racing sessions hydration was skipped (s-2 never filled in).
    expect(result.current.sessionById.has('s-2')).toBe(false);
  });
});
