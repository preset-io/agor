import { eq } from 'drizzle-orm';
import type { Database } from './client';
import { lockRowForUpdate, select } from './database-wrapper';
import { EntityNotFoundError, RepositoryError } from './repositories/base';
import { branches, sessions } from './schema';

/**
 * Shared Branch-first admission boundary. Call inside a short write transaction
 * before locking a Session/Task or committing new branch work. Holding this lock
 * is not a process-containment proof; lifecycle owners must settle admitted work.
 */
export async function lockBranchForAdmission(db: Database, branchId: string) {
  await lockRowForUpdate(db, db, branches, eq(branches.branch_id, branchId));
  const branch = await select(db).from(branches).where(eq(branches.branch_id, branchId)).one();
  if (!branch) throw new EntityNotFoundError('Branch', branchId);
  assertBranchActivityAllowed(branch);
  return branch;
}

/** Inspect only while holding the Branch row lock at the write boundary. */
export function assertBranchActivityAllowed(branch: typeof branches.$inferSelect): void {
  if (branch.deletion_status) {
    throw new RepositoryError(
      'Branch deletion is in progress or failed; only deletion recovery is allowed'
    );
  }
  if (branch.data.maintenance) {
    throw new RepositoryError('Branch maintenance is in progress; new activity is disabled');
  }
}

/** Resolve membership before taking the Branch lock; never lock Session first. */
export async function lockSessionBranchForAdmission(db: Database, sessionId: string) {
  const session = await select(db, { branch_id: sessions.branch_id })
    .from(sessions)
    .where(eq(sessions.session_id, sessionId))
    .one();
  if (!session) throw new EntityNotFoundError('Session', sessionId);
  const branch = await lockBranchForAdmission(db, session.branch_id);
  await lockRowForUpdate(db, db, sessions, eq(sessions.session_id, sessionId));
  const current = await select(db, { branch_id: sessions.branch_id })
    .from(sessions)
    .where(eq(sessions.session_id, sessionId))
    .one();
  if (!current || current.branch_id !== branch.branch_id) {
    throw new RepositoryError('Session branch changed during admission');
  }
  return branch;
}
