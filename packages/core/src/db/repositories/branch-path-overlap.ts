import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { executeRaw, isPostgresDatabase, select } from '../database-wrapper';
import { branches } from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';

/** A new branch would share, contain, or nest inside another branch's workspace. */
export class BranchWorkspaceOverlapError extends RepositoryError {
  constructor(
    readonly branchName: string,
    readonly overlappingBranchName: string
  ) {
    super(
      `Branch name '${branchName}' would share a workspace with branch '${overlappingBranchName}'. Choose a name that is not a parent or child path of an existing branch.`
    );
    this.name = 'BranchWorkspaceOverlapError';
  }
}

/**
 * Serialize workspace path admission for the tenant. SQLite callers get the
 * same exclusion from an IMMEDIATE transaction.
 */
export async function lockBranchWorkspacePaths(tx: Database): Promise<void> {
  if (!isPostgresDatabase(tx)) return;
  const key = `branch-workspace-paths:${getCurrentTenantId() ?? 'global'}`;
  await executeRaw(
    tx,
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
  );
}

/**
 * Any other branch row, in any repo and lifecycle state, whose stored path
 * equals, contains, or sits inside `path`. Archived rows can retain files.
 */
export async function findOverlappingBranchPath(
  tx: Database,
  path: string,
  excludeBranchId?: string
): Promise<{ branch_id: string; name: string } | undefined> {
  // Escape LIKE patterns on both sides: stored paths are literals, not globs.
  const escapedPath = path.replace(/[!%_]/g, '!$&');
  const escapedSiblingPath = sql`replace(replace(replace(${branches.data} ->> 'path', '!', '!!'), '%', '!%'), '_', '!_')`;
  const row = await select(tx, { branch_id: branches.branch_id, name: branches.name })
    .from(branches)
    .where(sql`${excludeBranchId ? sql`${branches.branch_id} <> ${excludeBranchId} AND ` : sql``}(
      ${branches.data} ->> 'path' = ${path}
      OR ${branches.data} ->> 'path' LIKE ${`${escapedPath}/%`} ESCAPE '!'
      OR ${path} LIKE (${escapedSiblingPath} || '/%') ESCAPE '!')`)
    .limit(1)
    .one();
  return row ?? undefined;
}
