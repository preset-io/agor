import type { Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { buildSessionTree } from '../components/BranchCard/buildSessionTree';
import { applySessionPatchToMaps, buildSessionMaps, type DataMaps } from './agorMaps';

// A session archive lands in the store as one `sessions.patched` per affected
// row (the root plus every branch-local descendant). Remote-created children
// keep their own lifecycle, but the muted surrogates projected under an
// archived creator must leave with it: otherwise their genealogy edge points
// at a session that is no longer rendered and the tree promotes them to roots.

const makeSession = (
  id: string,
  branchId: string,
  genealogy: Partial<NonNullable<Session['genealogy']>> = {},
  extra: Partial<Session> = {}
): Session =>
  ({
    session_id: id,
    branch_id: branchId,
    status: 'idle',
    archived: false,
    created_at: '2026-09-25T00:00:00.000Z',
    last_updated: '2026-09-25T00:00:00.000Z',
    genealogy: { children: [], ...genealogy },
    ...extra,
  }) as unknown as Session;

const remoteCreate = (source: string, target: string) => ({
  as_source: [
    {
      relationship_id: `${source}->${target}`,
      relationship_type: 'remote_create',
      source_session_id: source,
      target_session_id: target,
    },
  ],
});

// Branch A: root --spawn--> child --fork--> grandchild --spawn--> great.
// root and grandchild each remote-created a session in branch B.
function buildFixture() {
  const root = makeSession('root', 'A', {}, {
    remote_relationships: remoteCreate('root', 'remote-1'),
  } as Partial<Session>);
  const child = makeSession('child', 'A', { parent_session_id: 'root' as Session['session_id'] });
  const grandchild = makeSession(
    'grandchild',
    'A',
    { forked_from_session_id: 'child' as Session['session_id'] },
    { remote_relationships: remoteCreate('grandchild', 'remote-2') } as Partial<Session>
  );
  const great = makeSession('great', 'A', {
    parent_session_id: 'grandchild' as Session['session_id'],
  });
  const remote1 = makeSession('remote-1', 'B');
  const remote2 = makeSession('remote-2', 'B');
  return { root, child, grandchild, great, remote1, remote2 };
}

function toDataMaps(sessions: Session[]): DataMaps {
  return buildSessionMaps(sessions) as unknown as DataMaps;
}

const ids = (sessions: Session[] | undefined) =>
  (sessions ?? []).map((session) => session.session_id).sort();

describe('session archive reconciliation in branch buckets', () => {
  it('projects remote surrogates under their creators before archive', () => {
    const f = buildFixture();
    const maps = toDataMaps(Object.values(f));

    const tree = buildSessionTree(maps.sessionsByBranch.get('A') ?? []);
    expect(tree.map((node) => node.key)).toEqual(['root']);
    expect(ids(maps.sessionsByBranch.get('A'))).toEqual(
      ['child', 'grandchild', 'great', 'remote-1', 'remote-2', 'root'].sort()
    );
  });

  it('removes the whole archived tree, including projected surrogates, without re-rooting', () => {
    const f = buildFixture();
    let maps = toDataMaps(Object.values(f));

    // Payloads mirror the archive route's affected rows (root + descendants).
    for (const session of [f.root, f.child, f.grandchild, f.great]) {
      maps = applySessionPatchToMaps(maps, { ...session, archived: true });
    }

    expect(maps.sessionsByBranch.get('A')).toBeUndefined();
    expect(buildSessionTree(maps.sessionsByBranch.get('A') ?? [])).toEqual([]);
    // Remote-created sessions keep their independent lifecycle in their branch.
    expect(ids(maps.sessionsByBranch.get('B'))).toEqual(['remote-1', 'remote-2']);
  });

  it('drops surrogates of an archived intermediate creator even when patches arrive child-first', () => {
    const f = buildFixture();
    let maps = toDataMaps(Object.values(f));

    for (const session of [f.great, f.grandchild, f.child, f.root]) {
      maps = applySessionPatchToMaps(maps, { ...session, archived: true });
      const tree = buildSessionTree(maps.sessionsByBranch.get('A') ?? []);
      // At every intermediate step the remaining rows still hang off `root`.
      expect(tree.map((node) => node.key).filter((key) => key !== 'root')).toEqual([]);
    }
    expect(maps.sessionsByBranch.get('A')).toBeUndefined();
  });

  it('restores the tree and re-projects surrogates when unarchive patches carry relationships', () => {
    const f = buildFixture();
    let maps = toDataMaps(Object.values(f));
    for (const session of [f.root, f.child, f.grandchild, f.great]) {
      maps = applySessionPatchToMaps(maps, { ...session, archived: true });
    }

    for (const session of [f.root, f.child, f.grandchild, f.great]) {
      maps = applySessionPatchToMaps(maps, { ...session, archived: false });
    }

    const tree = buildSessionTree(maps.sessionsByBranch.get('A') ?? []);
    expect(tree.map((node) => node.key)).toEqual(['root']);
    const rootChildren = tree[0]?.children?.map((node) => node.key).sort();
    expect(rootChildren).toEqual(['child', 'remote-1']);
    const grandchildNode = tree[0]?.children
      ?.find((node) => node.key === 'child')
      ?.children?.find((node) => node.key === 'grandchild');
    expect(grandchildNode?.children?.map((node) => node.key).sort()).toEqual(['great', 'remote-2']);
  });
});
