import type { Board, Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { buildById, buildSessionMaps, reconcileByIdMap } from './agorMaps';

// These guard the "reference-stable rebuild" contract: a wholesale rebuild of
// already-loaded data (the background "load whole store" hydration, reconnect
// resync) must reuse prior references so it doesn't re-render the whole board.
// See the home→board load regression investigation.

const makeSession = (id: string, branchId: string, status = 'running'): Session =>
  ({
    session_id: id,
    branch_id: branchId,
    status,
    archived: false,
    created_at: '2026-06-24T00:00:00.000Z',
    last_updated: '2026-06-24T00:00:00.000Z',
  }) as unknown as Session;

const makeBoard = (id: string, name = 'Board'): Board =>
  ({ board_id: id, name, slug: id, archived: false }) as unknown as Board;

describe('reconcileByIdMap', () => {
  it('returns the prior map when nothing changed', () => {
    const prev = buildById([makeBoard('a'), makeBoard('b')], 'board_id');
    const next = new Map(prev); // same refs, different map object
    expect(reconcileByIdMap(prev, next)).toBe(prev);
  });

  it('reuses prior refs for value-equal rows and only the map identity changes', () => {
    const a = makeBoard('a');
    const b = makeBoard('b');
    const prev = buildById([a, b], 'board_id');

    // Fresh objects with identical values (mirrors a wholesale refetch).
    const next = new Map([
      ['a', makeBoard('a')],
      ['b', makeBoard('b', 'B renamed')],
    ]);
    const result = reconcileByIdMap(prev, next);

    expect(result).not.toBe(prev); // b changed → new map
    expect(result.get('a')).toBe(a); // unchanged row keeps its ref
    expect(result.get('b')).not.toBe(b); // changed row is the new ref
    expect(result.get('b')?.name).toBe('B renamed');
  });

  it('treats added/removed keys as a change', () => {
    const prev = buildById([makeBoard('a')], 'board_id');
    const next = new Map([
      ['a', makeBoard('a')],
      ['c', makeBoard('c')],
    ]);
    expect(reconcileByIdMap(prev, next)).not.toBe(prev);
  });
});

describe('buildSessionMaps reference stability', () => {
  it('rebuilding identical data against prev returns the prior maps', () => {
    const sessions = [makeSession('s1', 'A'), makeSession('s2', 'B')];
    const prev = buildSessionMaps(sessions);

    // Fresh session objects, identical values — the wholesale-hydration case.
    const rebuilt = buildSessionMaps([makeSession('s1', 'A'), makeSession('s2', 'B')], prev);

    expect(rebuilt.sessionById).toBe(prev.sessionById);
    expect(rebuilt.sessionsByBranch).toBe(prev.sessionsByBranch);
  });

  it('only the changed branch bucket gets a new array; others are preserved', () => {
    const prev = buildSessionMaps([makeSession('s1', 'A'), makeSession('s2', 'B')]);
    const bucketABefore = prev.sessionsByBranch.get('A');
    const bucketBBefore = prev.sessionsByBranch.get('B');

    // s2 (branch B) changes status; branch A untouched.
    const rebuilt = buildSessionMaps(
      [makeSession('s1', 'A'), makeSession('s2', 'B', 'completed')],
      prev
    );

    expect(rebuilt.sessionsByBranch).not.toBe(prev.sessionsByBranch); // B changed
    expect(rebuilt.sessionsByBranch.get('A')).toBe(bucketABefore); // A bucket ref preserved
    expect(rebuilt.sessionsByBranch.get('B')).not.toBe(bucketBBefore); // B bucket rebuilt
    expect(rebuilt.sessionById.get('s1')).toBe(prev.sessionById.get('s1')); // unchanged session ref kept
  });

  it('behaves like a plain build when no prev is supplied', () => {
    const built = buildSessionMaps([makeSession('s1', 'A')]);
    expect(built.sessionById.get('s1')?.session_id).toBe('s1');
    expect(built.sessionsByBranch.get('A')).toHaveLength(1);
  });

  it('preserves remote surrogate rows when rebuilding against prev', () => {
    const source = {
      ...makeSession('source', 'A'),
      remote_relationships: {
        as_source: [
          {
            relationship_type: 'remote_create',
            source_session_id: 'source',
            target_session_id: 'target',
          },
        ],
      },
    } as unknown as Session;
    const target = makeSession('target', 'B');
    const prev = buildSessionMaps([source, target]);

    const rebuilt = buildSessionMaps([{ ...source }, { ...target }], prev);
    const sourceBucket = rebuilt.sessionsByBranch.get('A') ?? [];
    const surrogate = sourceBucket.find(
      (session) => session.session_id === 'target' && session.remote_surrogate
    );

    expect(surrogate).toBeDefined();
    expect(surrogate?.branch_id).toBe('A');
    expect(surrogate?.genealogy?.parent_session_id).toBe('source');
    expect(surrogate?.remote_surrogate?.source_session_id).toBe('source');
    expect(surrogate?.remote_surrogate?.target_branch_id).toBe('B');
  });
});
