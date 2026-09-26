import { eq } from 'drizzle-orm';
import type { Database } from './client';
import { jsonExtract, select } from './database-wrapper';
import { RepositoryError } from './repositories/base';
import { boards, users } from './schema';

/** Canonical designations protect personal homes independently of repo cleanup policy. */
export async function assertNotPrimaryTeammate(db: Database, branchId: string): Promise<void> {
  const board = await select(db, { id: boards.board_id })
    .from(boards)
    .where(eq(boards.primary_teammate_id, branchId))
    .limit(1)
    .one();
  const user = await select(db, { id: users.user_id })
    .from(users)
    .where(eq(jsonExtract(db, users.data, 'primary_teammate_id'), branchId))
    .limit(1)
    .one();
  if (board || user)
    throw new RepositoryError(
      'Primary teammate is protected from cleanup, archive, and deletion. Keep it active for routine maintenance; use a separately reviewed, target-specific cleanup procedure. Intentional retirement is a separate file-preserving action in Archive.'
    );
}
