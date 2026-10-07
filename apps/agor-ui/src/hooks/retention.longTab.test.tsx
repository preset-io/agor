/**
 * Long-tab retention: with global hydration off, opening and
 * closing many boards and sessions keeps the store on a plateau — the
 * displayed board, `RETAINED_BACKGROUND_PARTITIONS` recent partitions, the
 * user scope and the pinned rows — instead of growing with every visit, and
 * so do the ways a row can enter without an owner: replies that land after
 * their view unmounted, realtime on boards never loaded, archived deep links
 * and board loads that settle after the user moved on.
 */
import type { AgorClient, Board, Branch, CardWithType, Session } from '@agor-live/client';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetHydrationRevisions } from '../store/agorHydration';
import { branchPatched, sessionCreated } from '../store/agorRealtimeActions';
import { agorStore } from '../store/agorStore';
import { makeBoardReadySelector, RETAINED_BACKGROUND_PARTITIONS } from '../store/boardPartitions';
import { captureLoadLifetime } from '../store/loadLifetime';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { holdRows, pinRows } from '../store/retention';
import { USER_SCOPE_KEYS } from '../store/scopeMerge';
import { sessionMcpCreated } from '../store/sessionMcpActions';
import { fillOnDemand } from '../store/userScope';
import { useBoardPartition } from './useBoardPartition';
import { useEnsureSessions } from './useEnsureRows';
import { usePinnedOpenRows } from './usePinnedRows';

const AUTHORITY = 'user-me:member:1';
const ME = 'user-me';
const BOARDS = 20;
const BRANCHES_PER_BOARD = 5;
const SESSIONS_PER_BRANCH = 4;
const OPENED_SESSIONS = 50;

const boardId = (b: number) => `board-${b}`;
const branchId = (b: number, r: number) => `br-${b}-${r}`;
const sessionId = (b: number, r: number, s: number) => `s-${b}-${r}-${s}`;

/** Every board's rows on the server; one session per board is mine. */
function server() {
  const branches: Branch[] = [];
  const sessions: Session[] = [];
  const cards: CardWithType[] = [];
  for (let b = 0; b < BOARDS; b++) {
    cards.push({ card_id: `k-${b}`, board_id: boardId(b), title: 'card' } as CardWithType);
    for (let r = 0; r < BRANCHES_PER_BOARD; r++) {
      branches.push({
        branch_id: branchId(b, r),
        board_id: boardId(b),
        name: branchId(b, r),
        archived: false,
        created_by: 'user-other',
      } as Branch);
      for (let s = 0; s < SESSIONS_PER_BRANCH; s++) {
        sessions.push({
          session_id: sessionId(b, r, s),
          branch_id: branchId(b, r),
          branch_board_id: boardId(b),
          created_by: r === 0 && s === 0 ? ME : 'user-other',
          status: 'idle',
          archived: false,
          title: sessionId(b, r, s),
          genealogy: { children: [] },
        } as unknown as Session);
      }
    }
  }
  return { branches, sessions, cards };
}

function makeClient(rows: ReturnType<typeof server>) {
  const onBoard = <T extends { board_id?: string | null }>(list: T[], id: unknown) =>
    list.filter((row) => row.board_id === id);
  const client = {
    service: (name: string) => ({
      findAll: async ({ query }: { query: Record<string, unknown> }) => {
        if (name === 'branches') return onBoard(rows.branches, query.board_id);
        if (name === 'sessions')
          return rows.sessions.filter((s) => s.branch_board_id === query.board_id);
        if (name === 'cards') return onBoard(rows.cards, query.board_id);
        return [];
      },
      find: async ({ query }: { query: { session_id: { $in: string[] } } }) =>
        rows.sessions.filter((s) => query.session_id.$in.includes(s.session_id)),
      get: async (id: string) => ({ board_id: id, name: id, objects: {} }) as unknown as Board,
    }),
  } as unknown as AgorClient;
  return client;
}

/** The user scope: my sessions, loaded with their rows. */
function seedUserScope(rows: ReturnType<typeof server>) {
  const mine = rows.sessions.filter((s) => s.created_by === ME);
  agorStore.getState().applyMaps(
    (prev) => ({
      ...prev,
      sessionById: new Map([...prev.sessionById, ...mine.map((s) => [s.session_id, s] as const)]),
    }),
    (_maps, coverage) =>
      new Map(coverage).set(USER_SCOPE_KEYS.sessions, {
        status: 'loaded',
        ...captureLoadLifetime()!,
        generation: 0,
        userId: ME,
        members: { sessions: new Set(mine.map((s) => s.session_id)) },
        complete: true,
      })
  );
  return mine;
}

/** The app shell: the displayed board, and the open session read by id and pinned. */
function useShell(client: AgorClient, board: string | null, session: string | null) {
  useBoardPartition(client, board, { canUseMemberWorkspaceServices: true });
  useEnsureSessions(client, session ? [session] : []);
  usePinnedOpenRows({ sessions: [session] });
}

beforeEach(() => {
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
  const store = agorStore.getState();
  store.setDataAuthority(AUTHORITY);
  store.setLoading(false);
  store.replaceMaps({
    boardById: new Map(
      Array.from({ length: BOARDS }, (_, b) => [boardId(b), { board_id: boardId(b) } as Board])
    ),
  });
});
afterEach(() => {
  cleanup();
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

it('opening and closing 20 boards and 50 sessions keeps the store on a plateau', async () => {
  const rows = server();
  const client = makeClient(rows);
  const mine = seedUserScope(rows);

  const { rerender, unmount } = renderHook(
    ({ board, session }: { board: string | null; session: string | null }) =>
      useShell(client, board, session),
    { initialProps: { board: null as string | null, session: null as string | null } }
  );

  const perBoard = {
    branches: BRANCHES_PER_BOARD,
    sessions: BRANCHES_PER_BOARD * SESSIONS_PER_BRANCH,
  };
  const partitions = 1 + RETAINED_BACKGROUND_PARTITIONS;
  // Displayed + retained partitions, the user scope, and the open session with its pin.
  const bound = {
    branches: partitions * perBoard.branches,
    sessions: partitions * perBoard.sessions + mine.length + 1,
    cards: partitions,
  };
  const peak = { branches: 0, sessions: 0, cards: 0, partitions: 0 };
  const record = () => {
    const state = agorStore.getState();
    peak.branches = Math.max(peak.branches, state.branchById.size);
    peak.sessions = Math.max(peak.sessions, state.sessionById.size);
    peak.cards = Math.max(peak.cards, state.cardById.size);
    peak.partitions = Math.max(
      peak.partitions,
      [...state.coverage.keys()].filter((key) => key.startsWith('board:')).length
    );
    expect(state.branchById.size).toBeLessThanOrEqual(bound.branches);
    expect(state.sessionById.size).toBeLessThanOrEqual(bound.sessions);
    expect(state.cardById.size).toBeLessThanOrEqual(bound.cards);
  };

  for (let i = 0; i < OPENED_SESSIONS; i++) {
    const board = boardId(i % BOARDS);
    // A session on a board that is not loaded: read by id, pinned while open.
    const b = (i + 7) % BOARDS;
    const session = sessionId(b, 1 + (i % (BRANCHES_PER_BOARD - 1)), i % SESSIONS_PER_BRANCH);
    rerender({ board, session });
    await waitFor(() => {
      const state = agorStore.getState();
      expect(makeBoardReadySelector(board)(state)).toBe(true);
      expect(state.sessionById.has(session)).toBe(true);
    });
    record();
  }
  // Another user's branch on the displayed board moves to a board that isn't
  // loaded and back: its sessions leave with it, return with a reload of the
  // displayed board, and the store stays on the plateau.
  const shown = (OPENED_SESSIONS - 1) % BOARDS;
  const away = boardId((shown + BOARDS / 2) % BOARDS);
  const moving = branchId(shown, 1);
  const onBranch = () => rows.sessions.filter((s) => s.branch_id === moving);
  const moveTo = (target: string) => {
    rows.branches = rows.branches.map((b) =>
      b.branch_id === moving ? ({ ...b, board_id: target } as Branch) : b
    );
    rows.sessions = rows.sessions.map((s) =>
      s.branch_id === moving ? ({ ...s, branch_board_id: target } as Session) : s
    );
    const branch = rows.branches.find((b) => b.branch_id === moving)!;
    act(() => branchPatched(branch));
  };
  for (let round = 0; round < 5; round++) {
    moveTo(away);
    expect(onBranch().some((s) => agorStore.getState().sessionById.has(s.session_id))).toBe(false);
    moveTo(boardId(shown));
    await waitFor(() => {
      const state = agorStore.getState();
      expect(makeBoardReadySelector(boardId(shown))(state)).toBe(true);
      expect(onBranch().every((s) => state.sessionById.has(s.session_id))).toBe(true);
    });
    record();
  }

  // Close the session and leave for Home.
  rerender({ board: null, session: null });
  record();

  const state = agorStore.getState();
  const final = {
    branches: state.branchById.size,
    sessions: state.sessionById.size,
    cards: state.cardById.size,
    partitions: [...state.coverage.keys()].filter((key) => key.startsWith('board:')).length,
  };
  // The plateau: never more than the displayed board and the retained ones.
  expect(peak.partitions).toBe(partitions);
  expect(peak.branches).toBe(bound.branches);
  expect(peak.cards).toBe(bound.cards);
  // Home: the last RETAINED_BACKGROUND_PARTITIONS boards, the user scope, no pins.
  expect(final.partitions).toBe(RETAINED_BACKGROUND_PARTITIONS);
  expect(final.branches).toBe(RETAINED_BACKGROUND_PARTITIONS * perBoard.branches);
  expect(final.cards).toBe(RETAINED_BACKGROUND_PARTITIONS);
  const retainedMine = mine.filter((s) => !state.sessionById.has(s.session_id));
  expect(retainedMine).toEqual([]);
  expect(final.sessions).toBe(
    RETAINED_BACKGROUND_PARTITIONS * perBoard.sessions +
      mine.length -
      RETAINED_BACKGROUND_PARTITIONS
  );
  unmount();
});

/** `makeClient`, with every read held until `releaseAll`. */
function deferredClient(rows: ReturnType<typeof server>) {
  const client = makeClient(rows);
  const held: (() => void)[] = [];
  const hold = <T,>(read: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => held.push(() => read().then(resolve, reject)));
  const deferred = {
    service: (name: string) => {
      const service = client.service(name as never) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      return {
        findAll: (...args: unknown[]) => hold(() => service.findAll(...args)),
        find: (...args: unknown[]) => hold(() => service.find(...args)),
        get: (...args: unknown[]) => hold(() => service.get(...args)),
      };
    },
  } as unknown as AgorClient;
  const releaseAll = async () => {
    while (held.length > 0) {
      await act(async () => {
        for (const release of held.splice(0)) release();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  return { client: deferred, releaseAll };
}

it('rows that enter without an owner never lift the plateau', async () => {
  const rows = server();
  const mine = seedUserScope(rows);
  const perBoard = BRANCHES_PER_BOARD * SESSIONS_PER_BRANCH;
  const counts = () => {
    const state = agorStore.getState();
    return {
      partitions: [...state.coverage.keys()].filter((key) => key.startsWith('board:')).length,
      branches: state.branchById.size,
      sessions: state.sessionById.size,
      cards: state.cardById.size,
    };
  };
  // Home after leaving: the retained partitions and the user scope, no pins.
  const plateau = {
    partitions: RETAINED_BACKGROUND_PARTITIONS,
    branches: RETAINED_BACKGROUND_PARTITIONS * BRANCHES_PER_BOARD,
    sessions:
      RETAINED_BACKGROUND_PARTITIONS * perBoard + mine.length - RETAINED_BACKGROUND_PARTITIONS,
    cards: RETAINED_BACKGROUND_PARTITIONS,
  };

  // Deferred board loads: visit 8 boards, each read still in flight when
  // the next one is displayed; they settle after the user went Home.
  const slow = deferredClient(rows);
  const shell = renderHook(
    ({ board }: { board: string | null }) => useShell(slow.client, board, null),
    {
      initialProps: { board: boardId(0) as string | null },
    }
  );
  for (let b = 1; b < 8; b++) shell.rerender({ board: boardId(b) });
  shell.rerender({ board: null });
  await slow.releaseAll();
  expect(counts()).toEqual(plateau);

  // Late replies: 20 views ask for sessions on unloaded boards and unmount
  // before the reads answer.
  const late = deferredClient(rows);
  for (let i = 0; i < 20; i++) {
    const view = renderHook(() =>
      useEnsureSessions(late.client, [sessionId(10 + (i % 10), 1, i % 4)])
    );
    view.unmount();
  }
  const search = holdRows();
  const searched = fillOnDemand(
    async () => ({ sessions: rows.sessions.filter((s) => s.branch_board_id === boardId(15)) }),
    search
  );
  search.release();
  await late.releaseAll();
  await searched;
  expect(counts()).toEqual(plateau);

  // Realtime on boards never loaded: 100 other users' sessions.
  for (let i = 0; i < 100; i++) {
    sessionCreated({
      ...rows.sessions[0],
      session_id: `s-live-${i}`,
      branch_id: branchId(10 + (i % 10), 2),
      branch_board_id: boardId(10 + (i % 10)),
      created_by: 'user-other',
    } as Session);
    // Their MCP links follow the rows: none enters.
    sessionMcpCreated({ session_id: `s-live-${i}`, mcp_server_id: 'mcp-1' });
  }
  expect(counts()).toEqual(plateau);
  expect(agorStore.getState().sessionMcpServerIds.size).toBe(0);

  // Archived deep links: each opened (route pin and the link's hold) and left.
  for (let i = 0; i < 20; i++) {
    const id = `s-archived-${i}`;
    const route = pinRows({ sessions: [id] });
    const link = holdRows();
    await fillOnDemand(
      async () => ({
        sessions: [{ ...rows.sessions[0], session_id: id, archived: true } as Session],
      }),
      link
    );
    expect(agorStore.getState().sessionById.has(id)).toBe(true);
    link.release();
    route();
  }
  expect(counts()).toEqual(plateau);

  // A retained board's branch moved live onto a board never loaded: it and
  // its sessions leave with the scope that held them.
  const moved = rows.branches.find((branch) => branch.branch_id === branchId(5, 1))!;
  branchPatched({ ...moved, board_id: boardId(15) });
  expect(counts()).toEqual({
    ...plateau,
    branches: plateau.branches - 1,
    sessions: plateau.sessions - SESSIONS_PER_BRANCH,
  });
  shell.unmount();
});
