import { describe, expect, it } from 'vitest';
import {
  planUnixGroupUuidMigration,
  runUnixGroupUuidMigration,
  type UnixGroupMigrationAdapter,
  type UnixGroupMigrationResource,
} from './group-uuid-migration.js';

const firstId = '019ffd3d-2cef-79d1-a1c6-407300000001';
const secondId = '019ffd3d-2cef-7abc-b2d7-518400000002';
const singletonId = '019aaaaa-1111-7aaa-8aaa-111111111111';

function branch(id: string, group: string): UnixGroupMigrationResource {
  return { kind: 'branch', id, unixGroup: group, label: id };
}

describe('planUnixGroupUuidMigration', () => {
  const legacyCollisionGroup = 'agor_wt_019ffd3d';
  const singletonGroup = 'agor_wt_019aaaaa';
  const resources = [
    branch(firstId, legacyCollisionGroup),
    branch(secondId, legacyCollisionGroup),
    branch(singletonId, singletonGroup),
  ];

  it('limits --only-dups to actual legacy collision cohorts', () => {
    const plan = planUnixGroupUuidMigration(resources, { onlyDuplicates: true });

    expect(plan).toHaveLength(1);
    expect(plan[0].legacyGroup).toBe(legacyCollisionGroup);
    expect(plan[0].resources.map((resource) => resource.id)).toEqual([firstId, secondId]);
    expect(new Set(plan[0].resources.map((resource) => resource.newGroup)).size).toBe(2);
  });

  it('plans every legacy group in full mode', () => {
    const plan = planUnixGroupUuidMigration(resources, { onlyDuplicates: false });

    expect(plan.map((cohort) => cohort.legacyGroup)).toEqual([
      singletonGroup,
      legacyCollisionGroup,
    ]);
    expect(plan.reduce((count, cohort) => count + cohort.resources.length, 0)).toBe(3);
  });

  it('retains a partially migrated collision cohort for resumed planning', () => {
    const canonicalFirst = 'agor_wt_019ffd3d2cef79d1a1c64073';
    const plan = planUnixGroupUuidMigration(
      [branch(firstId, canonicalFirst), branch(secondId, legacyCollisionGroup)],
      { onlyDuplicates: true, existingSystemGroups: [legacyCollisionGroup] }
    );

    expect(plan).toHaveLength(1);
    expect(plan[0].resources.map((resource) => resource.id)).toEqual([secondId]);
    expect(plan[0].collisionResourceIds).toEqual([firstId, secondId]);
  });
});

interface FakeState {
  rows: Map<string, string>;
  systemGroups: Set<string>;
  pathGroups: Map<string, string>;
  members: Map<string, Set<string>>;
  failCasFor?: string;
  extraOldRoot?: string;
}

function adapterFor(state: FakeState): UnixGroupMigrationAdapter {
  return {
    log: () => undefined,
    ensureGroup: async (groupName) => {
      state.systemGroups.add(groupName);
      if (!state.members.has(groupName)) state.members.set(groupName, new Set());
    },
    expectedMembers: async (resource) => new Set([`user-${resource.id.slice(-1)}`, 'daemon']),
    reconcileMembers: async (groupName, expected) => {
      state.members.set(groupName, new Set(expected));
    },
    verifyMembers: async (groupName, expected) => {
      expect(state.members.get(groupName)).toEqual(expected);
    },
    applyFilesystem: async (resource) => {
      state.pathGroups.set(`/managed/${resource.id}`, resource.newGroup);
    },
    verifyFilesystem: async (resource) => {
      expect(state.pathGroups.get(`/managed/${resource.id}`)).toBe(resource.newGroup);
    },
    compareAndSetGroup: async (resource) => {
      if (state.failCasFor === resource.id) throw new Error('simulated interruption');
      const current = state.rows.get(resource.id);
      if (current === resource.newGroup) return 'already-updated';
      if (current !== resource.unixGroup) return 'conflict';
      state.rows.set(resource.id, resource.newGroup);
      return 'updated';
    },
    findDatabaseReferences: async (groupName) =>
      [...state.rows].filter(([, current]) => current === groupName).map(([id]) => `branch:${id}`),
    findManagedRootsUsingGroup: async (groupName) => {
      const roots = [...state.pathGroups]
        .filter(([, current]) => current === groupName)
        .map(([path]) => path);
      if (state.extraOldRoot && groupName === 'agor_wt_019ffd3d') {
        roots.push(state.extraOldRoot);
      }
      return roots;
    },
    groupExists: async (groupName) => state.systemGroups.has(groupName),
    deleteGroup: async (groupName) => {
      state.systemGroups.delete(groupName);
      state.members.delete(groupName);
    },
  };
}

describe('runUnixGroupUuidMigration', () => {
  const legacyGroup = 'agor_wt_019ffd3d';

  it('converges after an interrupted cohort is resumed', async () => {
    const state: FakeState = {
      rows: new Map([
        [firstId, legacyGroup],
        [secondId, legacyGroup],
      ]),
      systemGroups: new Set([legacyGroup]),
      pathGroups: new Map([
        [`/managed/${firstId}`, legacyGroup],
        [`/managed/${secondId}`, legacyGroup],
      ]),
      members: new Map([[legacyGroup, new Set(['contaminated-user'])]]),
      failCasFor: secondId,
    };

    const firstPlan = planUnixGroupUuidMigration(
      [branch(firstId, state.rows.get(firstId)!), branch(secondId, state.rows.get(secondId)!)],
      { onlyDuplicates: true, existingSystemGroups: state.systemGroups }
    );
    const interrupted = await runUnixGroupUuidMigration(firstPlan, adapterFor(state));

    expect(interrupted.migrated).toBe(1);
    expect(interrupted.errors).toHaveLength(1);
    expect(state.systemGroups.has(legacyGroup)).toBe(true);
    expect(state.rows.get(secondId)).toBe(legacyGroup);

    state.failCasFor = undefined;
    const resumedPlan = planUnixGroupUuidMigration(
      [branch(firstId, state.rows.get(firstId)!), branch(secondId, state.rows.get(secondId)!)],
      { onlyDuplicates: true, existingSystemGroups: state.systemGroups }
    );
    const resumed = await runUnixGroupUuidMigration(resumedPlan, adapterFor(state));

    expect(resumed.errors).toHaveLength(0);
    expect(resumed.migrated).toBe(1);
    expect(state.systemGroups.has(legacyGroup)).toBe(false);
    expect([...state.rows.values()]).not.toContain(legacyGroup);
  });

  it('never deletes a legacy group while a managed root still uses it', async () => {
    const state: FakeState = {
      rows: new Map([[firstId, legacyGroup]]),
      systemGroups: new Set([legacyGroup]),
      pathGroups: new Map([[`/managed/${firstId}`, legacyGroup]]),
      members: new Map([[legacyGroup, new Set(['contaminated-user'])]]),
      extraOldRoot: '/managed/unrelated-but-still-using-old-group',
    };
    const plan = planUnixGroupUuidMigration([branch(firstId, legacyGroup)], {
      onlyDuplicates: false,
      existingSystemGroups: state.systemGroups,
    });

    const result = await runUnixGroupUuidMigration(plan, adapterFor(state));

    expect(result.errors).toHaveLength(0);
    expect(result.retained).toEqual([
      {
        group: legacyGroup,
        reason: 'still used by managed root(s): /managed/unrelated-but-still-using-old-group',
      },
    ]);
    expect(state.systemGroups.has(legacyGroup)).toBe(true);
  });
});
