import type { Board, BoardEntityObject, Branch, CardWithType, Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { type DataMaps, EMPTY_MAPS } from './agorMaps';
import {
  boardPartitionScope,
  replaceScope,
  scopeMembers,
  USER_SCOPE_KEYS,
  userScopePiece,
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

/** Store state built from rows (fresh, no fence, nothing to remove). */
function storeWith(rows: {
  branches?: Branch[];
  sessions?: Session[];
  boardObjects?: BoardEntityObject[];
  cards?: CardWithType[];
}): DataMaps {
  return replaceScope(EMPTY_MAPS, { key: USER_SCOPE_KEYS.references, claims: {} }, rows, never, []);
}

const never = () => false;
const touchedSet =
  (...keys: string[]) =>
  (collection: string, id: string) =>
    keys.includes(`${collection}:${id}`);
const scopeA = boardPartitionScope(A);
const ids = (map: Map<string, unknown>) => [...map.keys()].sort();

describe('replaceScope', () => {
  it('keeps an omitted session whose branch was written live during the read', () => {
    const prev = storeWith({
      branches: [branch('br-moved')],
      sessions: [session('s-1', 'br-moved')],
    });
    const next = replaceScope(
      prev,
      scopeA,
      { branches: [], sessions: [] },
      touchedSet('branches:br-moved'),
      []
    );
    expect(ids(next.sessionById)).toEqual(['s-1']);
  });

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
      {
        sessions: [session('s-orphan', 'br-gone')],
        boardObjects: [boardObject('o-orphan', { branch_id: 'br-gone' })],
      },
      touchedSet('branches:br-gone'),
      []
    );
    expect(next.sessionById.size).toBe(0);
    expect(next.boardObjectById.size).toBe(0);
  });

  it('projects remote-create surrogates regardless of snapshot order', () => {
    const target = session('s-target', 'br-2');
    const source = session('s-source', 'br-1', {
      remote_relationships: {
        as_source: [
          {
            relationship_type: 'remote_create',
            source_session_id: 's-source',
            target_session_id: 's-target',
          },
        ],
      },
    } as Partial<Session>);
    const next = replaceScope(
      EMPTY_MAPS,
      scopeA,
      { branches: [branch('br-1'), branch('br-2')], sessions: [source, target] },
      never,
      []
    );
    expect(next.sessionsByBranch.get('br-1')?.map((s) => s.session_id)).toEqual([
      's-source',
      's-target',
    ]);
    expect(next.sessionsByBranch.get('br-1')?.[1].remote_surrogate).toBeDefined();
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
  const mySessions = userScopePiece(USER_SCOPE_KEYS.sessions, ME);

  it("keeps a row another scope's committed read returned", () => {
    // Both of these moved off board A while disconnected (their stale rows still say A).
    const prev = storeWith({
      branches: [branch('br-mine'), branch('br-bob')],
      sessions: [session('s-mine', 'br-mine', { created_by: ME }), session('s-bob', 'br-bob')],
    });
    const user = scopeMembers({ sessions: [prev.sessionById.get('s-mine')!] });
    const next = replaceScope(prev, scopeA, { sessions: [] }, never, [user]);
    expect(ids(next.sessionById)).toEqual(['s-mine']);
    expect(next.sessionsByBranch.has('br-bob')).toBe(false);
    expect(next.sessionsByBranch.get('br-mine')?.map((s) => s.session_id)).toEqual(['s-mine']);

    // Without a committed read returning it nothing keeps it, so the replace removes it.
    const alone = replaceScope(prev, scopeA, { sessions: [] }, never, []);
    expect(alone.sessionById.size).toBe(0);
  });

  it('two scopes whose reads both omit a row converge: the second replace removes it', () => {
    // My session moved off board A while disconnected; the user scope's
    // earlier read returned it, and both scopes' predicates still claim it.
    const prev = storeWith({
      branches: [branch('br-1')],
      sessions: [session('s-mine', 'br-1', { created_by: ME })],
    });
    const userBefore = scopeMembers({ sessions: [prev.sessionById.get('s-mine')!] });
    const partitionRows = { sessions: [] };
    const afterPartition = replaceScope(prev, scopeA, partitionRows, never, [userBefore]);
    expect(afterPartition.sessionById.has('s-mine')).toBe(true);

    // The user scope reads again and omits it too: board A's committed read
    // didn't return it, so nothing keeps it.
    const afterUser = replaceScope(afterPartition, mySessions, { sessions: [] }, never, [
      scopeMembers(partitionRows),
    ]);
    expect(afterUser.sessionById.has('s-mine')).toBe(false);
  });

  it('a capped read overwrites the rows it returned but removes none', () => {
    const prev = storeWith({
      branches: [branch('br-1')],
      sessions: [
        session('s-1', 'br-1', { created_by: ME, title: 'stale' }),
        session('s-2', 'br-1', { created_by: ME }),
      ],
    });
    const rows = [session('s-1', 'br-1', { created_by: ME, title: 'fresh' })];
    const capped = replaceScope(prev, mySessions, { sessions: rows, complete: false }, never, []);
    expect(ids(capped.sessionById)).toEqual(['s-1', 's-2']);
    expect(capped.sessionById.get('s-1')?.title).toBe('fresh');
    // The same read, complete, removes what it omitted.
    const complete = replaceScope(prev, mySessions, { sessions: rows }, never, []);
    expect(ids(complete.sessionById)).toEqual(['s-1']);
  });

  it('keeps a branch another committed read returned, and removes the rest', () => {
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
    const user = scopeMembers({
      branches: [prev.branchById.get('br-referenced')!, prev.branchById.get('br-teammate')!],
    });
    const next = replaceScope(prev, scopeA, { branches: [] }, never, [user]);
    expect(ids(next.branchById)).toEqual(['br-referenced', 'br-teammate']);
  });

  it('each user-scope piece reconciles only its own rows', () => {
    const teammate = {
      custom_context: { teammate: { kind: 'teammate', displayName: 'T' } },
    } as Partial<Branch>;
    const prev = storeWith({
      branches: [
        branch('br-mine', { created_by: ME }),
        branch('br-teammate', { ...teammate, created_by: BOB }),
        branch('br-referenced', { created_by: BOB }),
      ],
      sessions: [session('s-mine', 'br-referenced', { created_by: ME })],
    });
    // My branches' read returned none: only my branch leaves.
    const mine = replaceScope(
      prev,
      userScopePiece(USER_SCOPE_KEYS.branches, ME),
      { branches: [] },
      never,
      []
    );
    expect(ids(mine.branchById)).toEqual(['br-referenced', 'br-teammate']);
    // The teammates' read returned none: only the teammate leaves.
    const teammates = replaceScope(
      prev,
      userScopePiece(USER_SCOPE_KEYS.teammates, ME),
      { branches: [] },
      never,
      []
    );
    expect(ids(teammates.branchById)).toEqual(['br-mine', 'br-referenced']);
    // My sessions claim no branch at all.
    expect(replaceScope(prev, mySessions, { branches: [] }, never, [])).toBe(prev);
  });

  it("a row whose current value says another board is not this scope's to remove", () => {
    const prev = storeWith({
      branches: [branch('br-b', { board_id: B })],
      sessions: [session('s-b', 'br-b', { branch_board_id: B })],
    });
    expect(replaceScope(prev, scopeA, { sessions: [], branches: [] }, never, [])).toBe(prev);
  });

  it('commits only rows that are not archived', () => {
    const members = scopeMembers({
      sessions: [session('s-live', 'br-1'), session('s-gone', 'br-1', { archived: true })],
      branches: [branch('br-gone', { archived: true })],
      boardObjects: null,
    });
    expect([...(members.sessions as Set<string>)]).toEqual(['s-live']);
    expect(members.branches?.has('br-gone')).toBe(false);
    expect(members.boardObjects).toBeUndefined();
  });

  it('overwrites a stale session row another scope also holds without removing it', () => {
    const prev = storeWith({
      branches: [branch('br-1')],
      sessions: [session('s-mine', 'br-1', { created_by: ME, title: 'stale' })],
    });
    const next = replaceScope(
      prev,
      scopeA,
      { sessions: [session('s-mine', 'br-1', { created_by: ME, title: 'fresh' })] },
      never,
      [scopeMembers({ sessions: [prev.sessionById.get('s-mine')!] })]
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
