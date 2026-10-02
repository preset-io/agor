import type { Board, BoardEntityObject, Branch, CardWithType, Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { type DataMaps, EMPTY_MAPS } from './agorMaps';
import {
  boardPartitionScope,
  fillScope,
  globalSetsClaims,
  type LoadScope,
  replaceScope,
  userScopeClaims,
} from './scopeMerge';

const A = 'board-a';
const B = 'board-b';
const ME = 'user-me';
const BOB = 'user-bob';

const branch = (id: string, overrides: Partial<Branch> = {}) =>
  ({ branch_id: id, board_id: A, name: id, archived: false, ...overrides }) as Branch;
const session = (id: string, branchId: string, overrides: Partial<Session> = {}) =>
  ({
    session_id: id,
    branch_id: branchId,
    branch_board_id: A,
    status: 'idle',
    archived: false,
    title: id,
    created_by: BOB,
    genealogy: { children: [] },
    ...overrides,
  }) as unknown as Session;
const boardObject = (id: string, overrides: Partial<BoardEntityObject> = {}) =>
  ({
    object_id: id,
    board_id: A,
    branch_id: undefined,
    position: { x: 0, y: 0 },
    ...overrides,
  }) as unknown as BoardEntityObject;
const card = (id: string, overrides: Partial<CardWithType> = {}) =>
  ({ card_id: id, board_id: A, title: id, ...overrides }) as CardWithType;

/** Store state built from rows with the fill reducer (fresh, no fence). */
function storeWith(rows: {
  branches?: Branch[];
  sessions?: Session[];
  boardObjects?: BoardEntityObject[];
  cards?: CardWithType[];
}): DataMaps {
  return fillScope(EMPTY_MAPS, rows, never);
}

const never = () => false;
const touchedSet =
  (...keys: string[]) =>
  (collection: string, id: string) =>
    keys.includes(`${collection}:${id}`);
const scopeA = boardPartitionScope(A);
const ids = (map: Map<string, unknown>) => [...map.keys()].sort();

describe('fillScope', () => {
  it('inserts absent rows and never overwrites or removes', () => {
    const prev = storeWith({
      cards: [card('k-1', { title: 'live' })],
      boardObjects: [boardObject('o-1')],
    });
    const next = fillScope(
      prev,
      { cards: [card('k-1', { title: 'stale' }), card('k-2')], boardObjects: [] },
      never
    );
    expect(next.cardById.get('k-1')?.title).toBe('live');
    expect(ids(next.cardById)).toEqual(['k-1', 'k-2']);
    expect(next.boardObjectById.has('o-1')).toBe(true);
  });
});

describe('replaceScope', () => {
  it('removes deleted rows, overwrites stale ones, and inserts new ones', () => {
    const prev = storeWith({
      boardObjects: [boardObject('o-kept'), boardObject('o-moved'), boardObject('o-deleted')],
      cards: [card('k-kept', { title: 'stale' }), card('k-deleted')],
    });
    const next = replaceScope(
      prev,
      scopeA,
      {
        boardObjects: [
          boardObject('o-kept'),
          boardObject('o-moved', { position: { x: 50, y: 60 } } as Partial<BoardEntityObject>),
          boardObject('o-new'),
        ],
        cards: [card('k-kept', { title: 'fresh' }), card('k-new')],
      },
      never,
      []
    );
    expect(ids(next.boardObjectById)).toEqual(['o-kept', 'o-moved', 'o-new']);
    expect(next.boardObjectById.get('o-moved')?.position).toEqual({ x: 50, y: 60 });
    expect(
      next.boardObjectsByBoardId
        .get(A)
        ?.map((o) => o.object_id)
        .sort()
    ).toEqual(['o-kept', 'o-moved', 'o-new']);
    expect(ids(next.cardById)).toEqual(['k-kept', 'k-new']);
    expect(next.cardById.get('k-kept')?.title).toBe('fresh');
  });

  it('keeps rows a live event touched during the load: value, insert and removal', () => {
    // During the load: k-live was created, k-patched patched, k-removed removed.
    const prev = storeWith({
      cards: [card('k-live'), card('k-patched', { title: 'live' })],
    });
    const next = replaceScope(
      prev,
      scopeA,
      { cards: [card('k-patched', { title: 'stale' }), card('k-removed')] },
      touchedSet('cards:k-live', 'cards:k-patched', 'cards:k-removed'),
      []
    );
    expect(ids(next.cardById)).toEqual(['k-live', 'k-patched']);
    expect(next.cardById.get('k-patched')?.title).toBe('live');
  });

  it('leaves rows of other boards alone and drops a row moved off the board', () => {
    // o-away moved to board B while disconnected: A's snapshot lacks it, and
    // its stale row still says A. B is unloaded (a reconnect unloads it).
    const prev = storeWith({
      boardObjects: [boardObject('o-away'), boardObject('o-b', { board_id: B })],
      cards: [card('k-b', { board_id: B })],
    });
    const next = replaceScope(prev, scopeA, { boardObjects: [], cards: [] }, never, []);
    expect(ids(next.boardObjectById)).toEqual(['o-b']);
    expect(ids(next.cardById)).toEqual(['k-b']);
    // B's own replace later inserts the row on B.
    const onB = replaceScope(
      next,
      boardPartitionScope(B),
      {
        boardObjects: [boardObject('o-b', { board_id: B }), boardObject('o-away', { board_id: B })],
      },
      never,
      []
    );
    expect(
      onB.boardObjectsByBoardId
        .get(B)
        ?.map((o) => o.object_id)
        .sort()
    ).toEqual(['o-away', 'o-b']);
  });

  it('removes rows that lost visibility, like any row the snapshot omits', () => {
    // Bob's branch became private: the server omits its board object.
    const prev = storeWith({
      boardObjects: [
        boardObject('o-mine', { branch_id: 'br-mine' }),
        boardObject('o-private', { branch_id: 'br-bob' }),
      ],
    });
    const next = replaceScope(
      prev,
      scopeA,
      { boardObjects: [boardObject('o-mine', { branch_id: 'br-mine' })] },
      never,
      []
    );
    expect(ids(next.boardObjectById)).toEqual(['o-mine']);
  });

  it('skips a snapshot row on a branch removed live during the load', () => {
    const next = replaceScope(
      EMPTY_MAPS,
      scopeA,
      { boardObjects: [boardObject('o-orphan', { branch_id: 'br-gone' })] },
      touchedSet('branches:br-gone'),
      []
    );
    expect(next.boardObjectById.size).toBe(0);
  });

  it('removes no board object when the caller could not read them (viewer)', () => {
    const prev = storeWith({ boardObjects: [boardObject('o-1')] });
    const next = replaceScope(prev, scopeA, { boardObjects: null, cards: [] }, never, []);
    expect(next.boardObjectById.has('o-1')).toBe(true);
  });

  it('replaces the board record unless the board was touched', () => {
    const lean = { board_id: A, name: 'A' } as Board;
    const full = { board_id: A, name: 'A', objects: { z: { type: 'zone' } } } as unknown as Board;
    const prev = { ...EMPTY_MAPS, boardById: new Map([[A, lean]]) };
    expect(replaceScope(prev, scopeA, { board: full }, never, []).boardById.get(A)).toBe(full);
    expect(
      replaceScope(prev, scopeA, { board: full }, touchedSet(`boards:${A}`), []).boardById.get(A)
    ).toBe(lean);
  });

  it('returns prev when the snapshot matches the store', () => {
    const prev = storeWith({ boardObjects: [boardObject('o-1')], cards: [card('k-1')] });
    const next = replaceScope(
      prev,
      scopeA,
      { boardObjects: [boardObject('o-1')], cards: [card('k-1')] },
      never,
      []
    );
    expect(next).toBe(prev);
  });
});

describe('replaceScope with overlapping scopes', () => {
  const user = (maps: DataMaps): LoadScope =>
    userScopeClaims(ME, () => new Set([...maps.sessionById.values()].map((s) => s.branch_id)));

  it("keeps my session missing from a board's snapshot while the user scope claims it", () => {
    // Both of these moved off board A while disconnected (their stale rows still say A).
    const prev = storeWith({
      branches: [branch('br-mine'), branch('br-bob')],
      sessions: [session('s-mine', 'br-mine', { created_by: ME }), session('s-bob', 'br-bob')],
    });
    const next = replaceScope(prev, scopeA, { sessions: [] }, never, [user(prev)]);
    expect(ids(next.sessionById)).toEqual(['s-mine']);
    expect(next.sessionsByBranch.has('br-bob')).toBe(false);
    expect(next.sessionsByBranch.get('br-mine')?.map((s) => s.session_id)).toEqual(['s-mine']);

    // Without the user scope nothing claims it, so the partition's replace removes it.
    const alone = replaceScope(prev, scopeA, { sessions: [] }, never, []);
    expect(alone.sessionById.size).toBe(0);
  });

  it('keeps a branch another loaded scope references, and removes an unclaimed one', () => {
    const prev = storeWith({
      branches: [
        branch('br-referenced'),
        branch('br-teammate', {
          custom_context: { teammate: { kind: 'teammate', displayName: 'T' } },
        } as Partial<Branch>),
        branch('br-other'),
      ],
      sessions: [session('s-mine', 'br-referenced', { created_by: ME, branch_board_id: B })],
    });
    const next = replaceScope(prev, scopeA, { branches: [] }, never, [user(prev)]);
    expect(ids(next.branchById)).toEqual(['br-referenced', 'br-teammate']);
  });

  it('a loaded partition of another board claims its own rows', () => {
    // A row whose CURRENT store value says board B is B's, never A's.
    const prev = storeWith({
      branches: [branch('br-b', { board_id: B })],
      sessions: [session('s-b', 'br-b', { branch_board_id: B })],
    });
    const next = replaceScope(prev, scopeA, { sessions: [], branches: [] }, never, [
      boardPartitionScope(B),
    ]);
    expect(next).toBe(prev);
  });

  it('the global sets (Steps 1–2) claim every session and branch once hydrated', () => {
    const prev = storeWith({ branches: [branch('br-1')], sessions: [session('s-1', 'br-1')] });
    const global = globalSetsClaims(new Set(['sessions', 'branches']));
    expect(replaceScope(prev, scopeA, { sessions: [], branches: [] }, never, [global])).toBe(prev);
    // Annotations have no global claim.
    const withCard = storeWith({ cards: [card('k-1')] });
    expect(replaceScope(withCard, scopeA, { cards: [] }, never, [global]).cardById.size).toBe(0);
  });

  it('overwrites a stale session row claimed by both scopes without removing it', () => {
    const prev = storeWith({
      branches: [branch('br-1')],
      sessions: [session('s-mine', 'br-1', { created_by: ME, title: 'stale' })],
    });
    const next = replaceScope(
      prev,
      scopeA,
      { sessions: [session('s-mine', 'br-1', { created_by: ME, title: 'fresh' })] },
      never,
      [user(prev)]
    );
    expect(next.sessionById.get('s-mine')?.title).toBe('fresh');
    expect(next.sessionsByBranch.get('br-1')?.[0].title).toBe('fresh');
  });

  it('rebuilds the session maps once for a large replace', () => {
    const many = Array.from({ length: 100 }, (_, i) => session(`s-${i}`, 'br-1'));
    const prev = storeWith({ branches: [branch('br-1')], sessions: many });
    const next = replaceScope(prev, scopeA, { sessions: many.slice(0, 10) }, never, []);
    expect(next.sessionById.size).toBe(10);
    expect(next.sessionsByBranch.get('br-1')).toHaveLength(10);
  });
});
