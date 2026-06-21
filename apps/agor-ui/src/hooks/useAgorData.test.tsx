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

function makeMockClient(seed: Record<string, unknown[]> = {}) {
  const serviceListeners = new Map<string, Map<string, Listener[]>>();
  const ioListeners = new Map<string, Listener[]>();

  const service = (name: string) => ({
    findAll: vi.fn().mockResolvedValue(seed[name] ?? []),
    find: vi.fn().mockResolvedValue(seed[name] ?? []),
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
