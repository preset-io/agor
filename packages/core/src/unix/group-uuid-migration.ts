/**
 * Explicit migration support for legacy 8-character branch/repo Unix groups.
 *
 * Normal sync must never call this module: persisted `unix_group` values are
 * authoritative there. This compatibility layer exists solely for the local
 * administrative migration command and can be removed with Unix isolation.
 */

import type { BranchID, RepoID } from '../types/index.js';
import {
  generateBranchGroupName,
  generateLegacyBranchGroupName,
  generateLegacyRepoGroupName,
  generateRepoGroupName,
  isLegacyBranchGroupName,
  isLegacyRepoGroupName,
} from './group-manager.js';

export type UnixGroupResourceKind = 'branch' | 'repo';

export interface UnixGroupMigrationResource {
  kind: UnixGroupResourceKind;
  id: string;
  unixGroup: string | null | undefined;
  /** Human-readable label for progress output. */
  label: string;
}

export interface PlannedUnixGroupResource extends UnixGroupMigrationResource {
  unixGroup: string;
  newGroup: string;
}

export interface UnixGroupMigrationCohort {
  legacyGroup: string;
  kind: UnixGroupResourceKind;
  /** Rows that still require a compare-and-set from legacyGroup to newGroup. */
  resources: PlannedUnixGroupResource[];
  /** IDs that establish a real same-prefix legacy collision cohort. */
  collisionResourceIds: string[];
}

export interface PlanUnixGroupMigrationOptions {
  onlyDuplicates: boolean;
  /** Legacy groups currently present in the system-global Unix namespace. */
  existingSystemGroups?: Iterable<string>;
}

function namesForResource(resource: UnixGroupMigrationResource): {
  legacy: string;
  canonical: string;
} {
  return resource.kind === 'branch'
    ? {
        legacy: generateLegacyBranchGroupName(resource.id as BranchID),
        canonical: generateBranchGroupName(resource.id as BranchID),
      }
    : {
        legacy: generateLegacyRepoGroupName(resource.id as RepoID),
        canonical: generateRepoGroupName(resource.id as RepoID),
      };
}

function isLegacyGroupForKind(kind: UnixGroupResourceKind, groupName: string): boolean {
  return kind === 'branch' ? isLegacyBranchGroupName(groupName) : isLegacyRepoGroupName(groupName);
}

function kindForLegacyGroup(groupName: string): UnixGroupResourceKind | null {
  if (isLegacyBranchGroupName(groupName)) return 'branch';
  if (isLegacyRepoGroupName(groupName)) return 'repo';
  return null;
}

function migrationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const command = (error as { command?: unknown } | null)?.command;
  return typeof command === 'string' && command ? `${message} (command: ${command})` : message;
}

/**
 * Build the migration plan without inspecting or mutating the OS.
 *
 * Duplicate-only mode selects actual cohorts: either two or more rows still
 * stamp the same legacy group, or two or more UUIDs map to that legacy prefix
 * and are already partially migrated. The latter makes interrupted reruns
 * converge, including cleanup-only reruns after every CAS already succeeded.
 */
export function planUnixGroupUuidMigration(
  resources: UnixGroupMigrationResource[],
  options: PlanUnixGroupMigrationOptions
): UnixGroupMigrationCohort[] {
  const systemGroups = new Set(options.existingSystemGroups ?? []);
  const currentLegacyRefs = new Map<string, UnixGroupMigrationResource[]>();
  const derivedCohorts = new Map<string, UnixGroupMigrationResource[]>();

  for (const resource of resources) {
    const { legacy, canonical } = namesForResource(resource);
    if (resource.unixGroup === legacy || resource.unixGroup === canonical) {
      const cohort = derivedCohorts.get(legacy) ?? [];
      cohort.push(resource);
      derivedCohorts.set(legacy, cohort);
    }

    if (resource.unixGroup && isLegacyGroupForKind(resource.kind, resource.unixGroup)) {
      const refs = currentLegacyRefs.get(resource.unixGroup) ?? [];
      refs.push(resource);
      currentLegacyRefs.set(resource.unixGroup, refs);
    }
  }

  const candidateGroups = new Set<string>(currentLegacyRefs.keys());

  // Full mode also owns cleanup of system-only legacy groups left behind by
  // deleted rows or an interrupted migration. The runner still performs the
  // same global DB and managed-root verification before deleting one.
  if (!options.onlyDuplicates) {
    for (const groupName of systemGroups) {
      if (kindForLegacyGroup(groupName)) candidateGroups.add(groupName);
    }
  }

  // A predecessor that is still on the OS but whose rows already contain the
  // canonical name represents an interrupted run after CAS and before cleanup.
  for (const [legacyGroup, cohort] of derivedCohorts) {
    if (
      systemGroups.has(legacyGroup) &&
      cohort.some((resource) => resource.unixGroup === namesForResource(resource).canonical)
    ) {
      candidateGroups.add(legacyGroup);
    }
  }

  const plan: UnixGroupMigrationCohort[] = [];
  for (const legacyGroup of candidateGroups) {
    const kind = kindForLegacyGroup(legacyGroup);
    if (!kind) continue;

    const currentRefs = currentLegacyRefs.get(legacyGroup) ?? [];
    const derived = derivedCohorts.get(legacyGroup) ?? [];
    const collisionResourceIds = Array.from(new Set(derived.map((resource) => resource.id)));
    const isActualDuplicate =
      currentRefs.length >= 2 ||
      (collisionResourceIds.length >= 2 &&
        (currentRefs.length > 0 || systemGroups.has(legacyGroup)));

    if (options.onlyDuplicates && !isActualDuplicate) continue;

    plan.push({
      legacyGroup,
      kind,
      collisionResourceIds,
      resources: currentRefs.map((resource) => ({
        ...resource,
        unixGroup: legacyGroup,
        newGroup: namesForResource(resource).canonical,
      })),
    });
  }

  return plan.sort((a, b) => a.legacyGroup.localeCompare(b.legacyGroup));
}

export type UnixGroupCompareAndSetResult = 'updated' | 'already-updated' | 'conflict';

export interface UnixGroupMigrationAdapter {
  ensureGroup(groupName: string): Promise<void>;
  expectedMembers(resource: PlannedUnixGroupResource): Promise<Set<string>>;
  reconcileMembers(groupName: string, expectedMembers: Set<string>): Promise<void>;
  verifyMembers(groupName: string, expectedMembers: Set<string>): Promise<void>;
  applyFilesystem(resource: PlannedUnixGroupResource): Promise<void>;
  verifyFilesystem(resource: PlannedUnixGroupResource): Promise<void>;
  compareAndSetGroup(resource: PlannedUnixGroupResource): Promise<UnixGroupCompareAndSetResult>;
  findDatabaseReferences(groupName: string): Promise<string[]>;
  findManagedRootsUsingGroup(groupName: string): Promise<string[]>;
  groupExists(groupName: string): Promise<boolean>;
  deleteGroup(groupName: string): Promise<void>;
  log(message: string): void;
}

export interface UnixGroupMigrationRunResult {
  migrated: number;
  groupsDeleted: number;
  errors: Array<{ resource: string; message: string }>;
  retained: Array<{ group: string; reason: string }>;
}

/**
 * Execute a plan in a forward-recoverable order:
 *
 * 1. create and reconstruct the new group;
 * 2. apply and verify every managed path;
 * 3. compare-and-set the DB row;
 * 4. delete the predecessor only after global DB and filesystem verification.
 */
export async function runUnixGroupUuidMigration(
  plan: UnixGroupMigrationCohort[],
  adapter: UnixGroupMigrationAdapter
): Promise<UnixGroupMigrationRunResult> {
  const result: UnixGroupMigrationRunResult = {
    migrated: 0,
    groupsDeleted: 0,
    errors: [],
    retained: [],
  };

  for (const cohort of plan) {
    adapter.log(`Migrating ${cohort.legacyGroup} (${cohort.resources.length} pending row(s))`);
    let cohortFailed = false;

    for (const resource of cohort.resources) {
      const resourceLabel = `${resource.kind} ${resource.label} (${resource.id})`;
      try {
        adapter.log(`  ${resourceLabel}: preparing ${resource.newGroup}`);
        await adapter.ensureGroup(resource.newGroup);

        // Membership is intentionally derived from current DB authorization;
        // the possibly contaminated predecessor is never read or copied.
        const expectedMembers = await adapter.expectedMembers(resource);
        await adapter.reconcileMembers(resource.newGroup, expectedMembers);
        await adapter.verifyMembers(resource.newGroup, expectedMembers);

        await adapter.applyFilesystem(resource);
        await adapter.verifyFilesystem(resource);

        const cas = await adapter.compareAndSetGroup(resource);
        if (cas === 'conflict') {
          throw new Error(
            `unix_group changed concurrently; expected ${resource.unixGroup} or ${resource.newGroup}`
          );
        }
        if (cas === 'updated') result.migrated += 1;
        adapter.log(`  ${resourceLabel}: ${cas === 'updated' ? 'migrated' : 'already migrated'}`);
      } catch (error) {
        cohortFailed = true;
        const message = migrationErrorMessage(error);
        result.errors.push({ resource: resourceLabel, message });
        adapter.log(`  ERROR ${resourceLabel}: ${message}`);
      }
    }

    if (cohortFailed) {
      result.retained.push({ group: cohort.legacyGroup, reason: 'one or more rows failed' });
      adapter.log(`  Retaining ${cohort.legacyGroup}: one or more rows failed`);
      continue;
    }

    let databaseReferences: string[];
    try {
      databaseReferences = await adapter.findDatabaseReferences(cohort.legacyGroup);
    } catch (error) {
      const message = migrationErrorMessage(error);
      result.errors.push({ resource: `cleanup ${cohort.legacyGroup}`, message });
      result.retained.push({ group: cohort.legacyGroup, reason: 'database verification failed' });
      adapter.log(`  Retaining ${cohort.legacyGroup}: database verification failed: ${message}`);
      continue;
    }
    if (databaseReferences.length > 0) {
      const reason = `still referenced by ${databaseReferences.length} database row(s)`;
      result.retained.push({ group: cohort.legacyGroup, reason });
      adapter.log(`  Retaining ${cohort.legacyGroup}: ${reason}`);
      continue;
    }

    let filesystemReferences: string[];
    try {
      filesystemReferences = await adapter.findManagedRootsUsingGroup(cohort.legacyGroup);
    } catch (error) {
      const message = migrationErrorMessage(error);
      result.errors.push({ resource: `cleanup ${cohort.legacyGroup}`, message });
      result.retained.push({ group: cohort.legacyGroup, reason: 'filesystem verification failed' });
      adapter.log(`  Retaining ${cohort.legacyGroup}: filesystem verification failed: ${message}`);
      continue;
    }
    if (filesystemReferences.length > 0) {
      const reason = `still used by managed root(s): ${filesystemReferences.join(', ')}`;
      result.retained.push({ group: cohort.legacyGroup, reason });
      adapter.log(`  Retaining ${cohort.legacyGroup}: ${reason}`);
      continue;
    }

    try {
      if (await adapter.groupExists(cohort.legacyGroup)) {
        await adapter.deleteGroup(cohort.legacyGroup);
        result.groupsDeleted += 1;
        adapter.log(`  Deleted verified-unused legacy group ${cohort.legacyGroup}`);
      } else {
        adapter.log(`  Legacy group ${cohort.legacyGroup} is already absent`);
      }
    } catch (error) {
      const message = migrationErrorMessage(error);
      result.errors.push({ resource: `cleanup ${cohort.legacyGroup}`, message });
      result.retained.push({ group: cohort.legacyGroup, reason: 'group deletion failed' });
      adapter.log(`  Retaining ${cohort.legacyGroup}: group deletion failed: ${message}`);
    }
  }

  return result;
}
