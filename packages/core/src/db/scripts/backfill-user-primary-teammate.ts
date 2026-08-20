/**
 * Backfill each user's primary teammate branch from their onboarding board.
 *
 * Source of truth is `preferences.mainBoardId` — the board onboarding already
 * created for the user. We copy that board's designated `primary_teammate_id`
 * branch (the teammate onboarding set up) into the per-user primary teammate.
 * Users with no `mainBoardId`, an unknown board, or a board that has no primary
 * teammate are deliberately left unset — a later UI phase prompts them.
 *
 * Runs within the ambient tenant context, so the standalone SQLite runner below
 * backfills the single local tenant. A multi-tenant caller should invoke
 * backfillUserPrimaryTeammates once per tenant scope.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BranchID } from '@agor/core/types';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import type { Database } from '../client';
import { BoardRepository } from '../repositories/boards';
import { UserPrimaryTeammateRepository } from '../repositories/user-primary-teammate';
import { UsersRepository } from '../repositories/users';

export interface BackfillUserPrimaryTeammateResult {
  /** Users whose primary teammate was set from their onboarding board. */
  assigned: number;
  /** Users left unset (no mainBoardId, unknown board, or board has no teammate). */
  skipped: number;
  /** Users who already had a primary teammate and were left untouched. */
  alreadySet: number;
}

export async function backfillUserPrimaryTeammates(
  db: Database
): Promise<BackfillUserPrimaryTeammateResult> {
  const users = new UsersRepository(db);
  const boards = new BoardRepository(db);
  const primaryTeammates = new UserPrimaryTeammateRepository(db);

  const result: BackfillUserPrimaryTeammateResult = { assigned: 0, skipped: 0, alreadySet: 0 };

  for (const user of await users.findAll()) {
    const mainBoardId = user.preferences?.mainBoardId;
    if (!mainBoardId) {
      result.skipped++;
      continue;
    }

    if (await primaryTeammates.getBranchId(user.user_id)) {
      result.alreadySet++;
      continue;
    }

    const board = await boards.findById(mainBoardId).catch(() => null);
    const teammateBranchId = board?.primary_teammate_id;
    if (!teammateBranchId) {
      result.skipped++;
      continue;
    }

    const eligible = await primaryTeammates.findEligiblePrimaryTeammate(
      teammateBranchId as BranchID,
      user.user_id
    );
    if (!eligible) {
      result.skipped++;
      continue;
    }

    const assigned = await primaryTeammates.setPrimaryTeammateIfUnset(
      user.user_id,
      teammateBranchId as BranchID,
      {
        source: 'default',
      }
    );
    if (assigned) result.assigned++;
    else result.alreadySet++;
  }

  return result;
}

async function main() {
  const dbPath = process.env.AGOR_DB_PATH || resolve(homedir(), '.agor/agor.db');
  const client = createClient({ url: `file:${dbPath}` });
  const db = drizzle(client) as unknown as Database;

  const { assigned, skipped, alreadySet } = await backfillUserPrimaryTeammates(db);
  console.log(
    `✅ Primary teammate backfill complete: ${assigned} assigned, ${alreadySet} already set, ${skipped} skipped`
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('❌ Primary teammate backfill failed:', error);
    process.exit(1);
  });
}
