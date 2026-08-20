import type { UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { BoardRepository } from '../repositories/boards';
import { BranchRepository } from '../repositories/branches';
import { RepoRepository } from '../repositories/repos';
import { UserPrimaryTeammateRepository } from '../repositories/user-primary-teammate';
import { UsersRepository } from '../repositories/users';
import { dbTest } from '../test-helpers';
import { backfillUserPrimaryTeammates } from './backfill-user-primary-teammate';

let branchUniqueId = 8_000;

async function createBoardWithTeammate(db: Database): Promise<{ boardId: UUID; branchId: UUID }> {
  const board = await new BoardRepository(db).create({
    board_id: generateId(),
    name: 'Onboarding board',
    created_by: generateId(),
    access_mode: 'shared',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `repo-${branchUniqueId}`,
    name: `repo-${branchUniqueId}`,
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/home/user/.agor/repos/repo-${branchUniqueId}`,
    default_branch: 'main',
  });
  const name = `teammate-${branchUniqueId}`;
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name,
    ref: name,
    branch_unique_id: branchUniqueId++,
    path: `/tmp/${name}`,
    board_id: board.board_id,
    created_by: generateId(),
    permission_source: 'board',
    custom_context: { teammate: { kind: 'teammate', displayName: name } },
  });
  await new BoardRepository(db).setPrimaryTeammate(board.board_id, branch.branch_id);
  return { boardId: board.board_id as UUID, branchId: branch.branch_id as UUID };
}

describe('backfillUserPrimaryTeammates', () => {
  dbTest('copies the onboarding board teammate when mainBoardId is present', async ({ db }) => {
    const { boardId, branchId } = await createBoardWithTeammate(db);
    const user = await new UsersRepository(db).create({
      email: 'has-board@example.com',
      role: 'member',
      preferences: { mainBoardId: boardId },
    });

    const result = await backfillUserPrimaryTeammates(db);

    expect(result.assigned).toBe(1);
    const primaryTeammates = new UserPrimaryTeammateRepository(db);
    expect(await primaryTeammates.getBranchId(user.user_id)).toBe(branchId);
    const resolved = await primaryTeammates.resolvePrimaryTeammate(user.user_id);
    expect(resolved?.branch_id).toBe(branchId);
  });

  dbTest('leaves the field unset when mainBoardId is absent', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      email: 'no-board@example.com',
      role: 'member',
    });

    const result = await backfillUserPrimaryTeammates(db);

    expect(result.skipped).toBe(1);
    expect(result.assigned).toBe(0);
    const primaryTeammates = new UserPrimaryTeammateRepository(db);
    expect(await primaryTeammates.getBranchId(user.user_id)).toBeNull();
  });

  dbTest('leaves the field unset when the board has no primary teammate', async ({ db }) => {
    const board = await new BoardRepository(db).create({
      board_id: generateId(),
      name: 'Teammate-less board',
      created_by: generateId(),
    });
    const user = await new UsersRepository(db).create({
      email: 'board-without-teammate@example.com',
      role: 'member',
      preferences: { mainBoardId: board.board_id },
    });

    const result = await backfillUserPrimaryTeammates(db);

    expect(result.assigned).toBe(0);
    expect(result.skipped).toBe(1);
    const primaryTeammates = new UserPrimaryTeammateRepository(db);
    expect(await primaryTeammates.getBranchId(user.user_id)).toBeNull();
  });

  dbTest('does not persist an inactive or non-teammate board default', async ({ db }) => {
    const { boardId, branchId } = await createBoardWithTeammate(db);
    await new BranchRepository(db).update(branchId, { archived: true });
    const user = await new UsersRepository(db).create({
      email: 'invalid-board-default@example.com',
      role: 'member',
      preferences: { mainBoardId: boardId },
    });

    const result = await backfillUserPrimaryTeammates(db);

    expect(result).toMatchObject({ assigned: 0, skipped: 1 });
    expect(await new UserPrimaryTeammateRepository(db).getBranchId(user.user_id)).toBeNull();
  });

  dbTest('does not overwrite a primary teammate that is already set', async ({ db }) => {
    const { boardId } = await createBoardWithTeammate(db);
    const user = await new UsersRepository(db).create({
      email: 'already-set@example.com',
      role: 'member',
      preferences: { mainBoardId: boardId },
    });
    const primaryTeammates = new UserPrimaryTeammateRepository(db);
    const existing = generateId() as UUID;
    await primaryTeammates.setPrimaryTeammate(user.user_id, existing, { source: 'explicit' });

    const result = await backfillUserPrimaryTeammates(db);

    expect(result.alreadySet).toBe(1);
    expect(result.assigned).toBe(0);
    expect(await primaryTeammates.getBranchId(user.user_id)).toBe(existing);
  });
});
