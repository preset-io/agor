import type { BoardEntityObject, CardWithType, Session } from '@agor-live/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeBranch, makeSession, withTestAuthority } from '../test/harness';
import { beginPartitionLoad, endPartitionLoad, touchedSince } from './agorHydration';
import {
  boardObjectCreated,
  branchCreated,
  branchPatched,
  cardCreated,
  sessionCreated,
  sessionPatched,
} from './agorRealtimeActions';
import { agorStore } from './agorStore';
import { captureLoadLifetime } from './loadLifetime';
import { enqueueSessionPatch, flushRealtimeNow, setRealtimeAuthorityScope } from './realtimeBatch';
import { anyOf, evictRows, pinRows } from './retention';
import { pinnedMembers } from './rowPins';
import {
  boardPartitionScope,
  boardScopeKey,
  replaceScope,
  type ScopeRows,
  USER_SCOPE_KEYS,
} from './scopeMerge';
import { otherCommittedMembers } from './userScope';

const AUTHORITY = 'user-a:member:1';
withTestAuthority(AUTHORITY);

const branch = (id: string, boardId: string) => makeBranch(id, { board_id: boardId });
const session = (id: string, branchId: string, boardId: string) =>
  makeSession(id, branchId, { branch_board_id: boardId });

const never = () => false;

/** Load `boardId` as a partition: its rows applied and its coverage loaded with them as members. */
function seedBoard(boardId: string, rows: Required<Pick<ScopeRows, 'branches' | 'sessions'>>) {
  const lifetime = captureLoadLifetime()!;
  agorStore.getState().applyMaps(
    (prev) => replaceScope(prev, boardPartitionScope(boardId), rows, never, []),
    (_maps, coverage) =>
      new Map(coverage).set(boardScopeKey(boardId), {
        status: 'loaded',
        ...lifetime,
        generation: 0,
        members: {
          branches: new Set(rows.branches.map((b) => b.branch_id)),
          sessions: new Set(rows.sessions.map((s) => s.session_id)),
        },
        complete: true,
      })
  );
}

/** Evict `boardId`'s partition, as the LRU does. */
const evictBoard = (boardId: string) =>
  evictRows(anyOf([boardPartitionScope(boardId)]), [boardScopeKey(boardId)]);

const has = (map: 'branchById' | 'sessionById', id: string) => agorStore.getState()[map].has(id);

describe('pins', () => {
  beforeEach(() =>
    seedBoard('b1', {
      branches: [branch('br-1', 'b1')],
      sessions: [session('s-1', 'br-1', 'b1'), session('s-2', 'br-1', 'b1')],
    })
  );

  it("keep the open session and its branch through their partition's eviction, until released", () => {
    const release = pinRows({ sessions: ['s-1'], branches: ['br-1'] });
    evictBoard('b1');
    expect(has('sessionById', 's-1')).toBe(true);
    expect(has('branchById', 'br-1')).toBe(true);
    expect(has('sessionById', 's-2')).toBe(false);
    release();
    expect(has('sessionById', 's-1')).toBe(false);
    expect(has('branchById', 'br-1')).toBe(false);
  });

  it('are ref-counted: a row leaves once the last view releases it', () => {
    const first = pinRows({ sessions: ['s-1'] });
    const second = pinRows({ sessions: ['s-1'] });
    evictBoard('b1');
    first();
    expect(has('sessionById', 's-1')).toBe(true);
    second();
    second();
    expect(has('sessionById', 's-1')).toBe(false);
    expect(pinnedMembers.sessions?.has('s-1')).toBe(false);
  });

  it('a release never evicts a row a scope still holds', () => {
    const release = pinRows({ sessions: ['s-1'], branches: ['br-1'] });
    release();
    // The partition still holds them.
    expect(has('sessionById', 's-1')).toBe(true);
    expect(has('branchById', 'br-1')).toBe(true);
    // My session belongs to the user scope too: it outlives the partition.
    agorStore.getState().setCoverage(USER_SCOPE_KEYS.sessions, {
      status: 'loaded',
      ...captureLoadLifetime()!,
      generation: 0,
      members: { sessions: new Set(['s-2']) },
    });
    evictBoard('b1');
    expect(has('sessionById', 's-2')).toBe(true);
    expect(has('sessionById', 's-1')).toBe(false);
  });

  it('a release while disconnected keeps the rows a scope of the earlier lifetime holds', () => {
    agorStore.getState().setCoverage(USER_SCOPE_KEYS.sessions, {
      status: 'loaded',
      ...captureLoadLifetime()!,
      generation: 0,
      members: { sessions: new Set(['s-1']) },
    });
    const release = pinRows({ sessions: ['s-1', 's-2'] });
    setRealtimeAuthorityScope(null);
    evictBoard('b1');
    release();
    expect(has('sessionById', 's-1')).toBe(true);
    expect(has('sessionById', 's-2')).toBe(false);
  });

  it('hold a row through a replace that omits it', () => {
    const release = pinRows({ sessions: ['s-1'] });
    agorStore
      .getState()
      .applyMaps((prev) =>
        replaceScope(
          prev,
          boardPartitionScope('b1'),
          { branches: [branch('br-1', 'b1')], sessions: [], complete: true },
          never,
          otherCommittedMembers(agorStore.getState(), boardScopeKey('b1'))
        )
      );
    expect(has('sessionById', 's-1')).toBe(true);
    expect(has('sessionById', 's-2')).toBe(false);
    release();
  });

  it("keep the open session's MCP links; an evicted session's links leave", () => {
    agorStore.getState().replaceMaps({
      sessionMcpServerIds: new Map([
        ['s-1', ['mcp-1']],
        ['s-2', ['mcp-2']],
      ]),
    });
    const release = pinRows({ sessions: ['s-1'], branches: ['br-1'] });
    evictBoard('b1');
    expect(agorStore.getState().sessionMcpServerIds.get('s-1')).toEqual(['mcp-1']);
    expect(agorStore.getState().sessionMcpServerIds.has('s-2')).toBe(false);
    release();
    expect(agorStore.getState().sessionMcpServerIds.has('s-1')).toBe(false);
  });

  it('a row realtime inserts on a loaded board joins it; one nothing holds never enters', () => {
    seedBoard('b2', { branches: [branch('br-2', 'b2')], sessions: [] });
    sessionCreated(session('s-live', 'br-2', 'b2'));
    sessionCreated(session('s-elsewhere', 'br-9', 'b9'));
    flushRealtimeNow(AUTHORITY);
    // The displayed board's membership follows realtime: evicting others keeps it.
    evictBoard('b1');
    pinRows({ sessions: ['s-other'] })();
    expect(has('sessionById', 's-live')).toBe(true);
    expect(agorStore.getState().coverage.get(boardScopeKey('b2'))?.members?.sessions).toContain(
      's-live'
    );
    expect(has('sessionById', 's-elsewhere')).toBe(false);
  });
});

describe('archived rows', () => {
  /** An archived deep-link target, filled for display. */
  const fillArchived = (id: string, boardId: string) =>
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map(prev.sessionById).set(id, {
        ...session(id, 'br-1', boardId),
        archived: true,
      }),
    }));

  it('leave when the last pin on them is released', () => {
    for (let i = 0; i < 20; i++) {
      const release = pinRows({ sessions: [`s-archived-${i}`] });
      fillArchived(`s-archived-${i}`, 'b9');
      release();
    }
    expect(agorStore.getState().sessionById.size).toBe(0);
  });

  it("leave with their board's partition when nothing else holds them", () => {
    seedBoard('b1', { branches: [branch('br-1', 'b1')], sessions: [] });
    fillArchived('s-archived', 'b1');
    evictBoard('b1');
    expect(has('sessionById', 's-archived')).toBe(false);
  });

  it("survive a list replace of their board: they're outside every list", () => {
    seedBoard('b1', { branches: [branch('br-1', 'b1')], sessions: [] });
    fillArchived('s-archived', 'b1');
    seedBoard('b1', { branches: [branch('br-1', 'b1')], sessions: [] });
    expect(has('sessionById', 's-archived')).toBe(true);
  });
});

describe('realtime admission (global hydration off)', () => {
  const other = (row: Session) => ({ ...row, created_by: 'user-b' }) as Session;

  it('on Home, 100 creates and patches on a board never loaded leave the store empty', () => {
    // A read in flight: it must still see what realtime wrote.
    const fence = beginPartitionLoad();
    for (let i = 0; i < 100; i++) {
      sessionCreated(other(session(`s-${i}`, `br-${i % 5}`, 'b9')));
      sessionPatched(other(session(`p-${i}`, `br-${i % 5}`, 'b9')));
      enqueueSessionPatch(AUTHORITY, other(session(`q-${i}`, `br-${i % 5}`, 'b9')));
      branchCreated(branch(`br-${i}`, 'b9'));
      cardCreated({ card_id: `k-${i}`, board_id: 'b9' } as CardWithType);
      boardObjectCreated({ object_id: `o-${i}`, board_id: 'b9' } as BoardEntityObject);
    }
    flushRealtimeNow(AUTHORITY);
    const state = agorStore.getState();
    expect(state.sessionById.size).toBe(0);
    expect(state.sessionsByBranch.size).toBe(0);
    expect(state.branchById.size).toBe(0);
    expect(state.cardById.size).toBe(0);
    expect(state.boardObjectById.size).toBe(0);
    // The fence is still recorded, so the read keeps out what it raced.
    expect(touchedSince('sessions', 's-0', fence.startRevisions.sessions)).toBe(true);
    expect(touchedSince('cards', 'k-0', fence.startRevisions.cards)).toBe(true);
    endPartitionLoad();
  });

  it('a written row that moves out of every scope leaves, with its sessions and their MCP state', () => {
    seedBoard('b1', {
      branches: [branch('br-1', 'b1'), branch('br-2', 'b1')],
      sessions: [other(session('s-1', 'br-1', 'b1')), other(session('s-2', 'br-2', 'b1'))],
    });
    seedBoard('b2', { branches: [], sessions: [] });
    agorStore.getState().replaceMaps({ sessionMcpServerIds: new Map([['s-1', ['mcp-1']]]) });
    agorStore.getState().markSessionMcpLoaded('s-1');
    // Moved to a board no scope loaded: nothing holds it or its session now.
    branchPatched(branch('br-1', 'b9'));
    // Moved to another loaded board: that board holds it.
    branchPatched(branch('br-2', 'b2'));
    const state = agorStore.getState();
    expect(state.branchById.has('br-1')).toBe(false);
    expect(state.sessionById.has('s-1')).toBe(false);
    expect(state.sessionsByBranch.has('br-1')).toBe(false);
    expect(state.sessionMcpServerIds.has('s-1')).toBe(false);
    expect(state.sessionMcpLoaded.has('s-1')).toBe(false);
    expect(state.branchById.has('br-2')).toBe(true);
    expect(state.sessionById.has('s-2')).toBe(true);
  });

  it('admits what a loading board, my user scope or a pin will hold', () => {
    agorStore.getState().setCoverage(boardScopeKey('b2'), {
      status: 'loading',
      ...captureLoadLifetime()!,
      generation: 0,
    });
    sessionCreated(other(session('s-loading', 'br-2', 'b2')));
    sessionCreated({ ...session('s-mine', 'br-9', 'b9'), created_by: 'user-a' } as Session);
    const release = pinRows({ sessions: ['s-open'] });
    sessionPatched(other(session('s-open', 'br-9', 'b9')));
    expect(has('sessionById', 's-loading')).toBe(true);
    expect(has('sessionById', 's-mine')).toBe(true);
    expect(has('sessionById', 's-open')).toBe(true);
    release();
    expect(has('sessionById', 's-open')).toBe(false);
  });
});
