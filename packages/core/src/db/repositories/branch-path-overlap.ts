import { sql } from 'drizzle-orm';
import { branchPathSpellings } from '../../config/config-manager';
import type { Database } from '../client';
import { executeRaw, isPostgresDatabase, select } from '../database-wrapper';
import { branches } from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';

/**
 * A new branch would share, contain, or nest inside another branch's
 * workspace. The message never names that branch: the caller may not see it.
 */
export class BranchWorkspaceOverlapError extends RepositoryError {
  constructor(
    readonly branchName: string,
    readonly overlappingBranchId: string
  ) {
    super(
      `Branch name '${branchName}' would share a workspace path with another branch. Choose a name that is not a parent or child path of an existing branch.`
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
  // Same fallback as the branches RLS policy, so unscoped and `default`
  // callers that read the same rows also share one lock.
  const key = `branch-workspace-paths:${getCurrentTenantId() ?? 'default'}`;
  await executeRaw(
    tx,
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
  );
}

/**
 * Any other branch row, in any repo and lifecycle state, whose stored path
 * equals, contains, or sits inside `path` under any of its spellings.
 * Archived rows can retain files.
 */
export async function findOverlappingBranchPath(
  tx: Database,
  path: string,
  excludeBranchId?: string
): Promise<{ branch_id: string } | undefined> {
  const stored = sql`${branches.data} ->> 'path'`;
  // Escape LIKE patterns on both sides: stored paths are literals, not globs.
  const escapedStored = sql`replace(replace(replace(${stored}, '!', '!!'), '%', '!%'), '_', '!_')`;
  const overlaps = branchPathSpellings(path, getCurrentTenantId()).map((spelling) => {
    const escaped = spelling.replace(/[!%_]/g, '!$&');
    return sql`(${stored} = ${spelling}
      OR ${stored} LIKE ${`${escaped}/%`} ESCAPE '!'
      OR ${spelling} LIKE (${escapedStored} || '/%') ESCAPE '!')`;
  });
  const row = await select(tx, { branch_id: branches.branch_id })
    .from(branches)
    .where(
      sql`${excludeBranchId ? sql`${branches.branch_id} <> ${excludeBranchId} AND ` : sql``}(${sql.join(overlaps, sql` OR `)})`
    )
    .limit(1)
    .one();
  return row ?? undefined;
}
