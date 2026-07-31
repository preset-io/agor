import {
  BranchRepository,
  type Database,
  generateId,
  RepoRepository,
  UserPrimaryTeammateRepository,
  UsersRepository,
} from '@agor/core/db';
import type { BranchID, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createUsersService } from './users';

const CALLER = 'caller-user' as UUID;
const CALLER_PARAMS = { user: { user_id: CALLER } } as never;

let uniqueId = 9_000;

async function ensureCaller(db: Database) {
  await new UsersRepository(db).create({
    user_id: CALLER,
    email: 'caller@example.com',
    role: 'member',
  });
}

async function createBranch(
  db: Database,
  overrides?: { created_by?: UUID; others_can?: 'none' | 'session' }
): Promise<BranchID> {
  const slug = `repo-${uniqueId}`;
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug,
    name: slug,
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${slug}`,
    default_branch: 'main',
  });
  const name = `teammate-${uniqueId}`;
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name,
    ref: name,
    branch_unique_id: uniqueId++,
    path: `/tmp/${name}`,
    created_by: overrides?.created_by ?? CALLER,
    permission_source: 'override',
    others_can: overrides?.others_can ?? 'session',
    custom_context: { teammate: { kind: 'teammate', displayName: name } },
  });
  return branch.branch_id as BranchID;
}

describe('UsersService primary teammate', () => {
  dbTest('getPrimaryTeammate returns null when unset', async ({ db }) => {
    await ensureCaller(db);
    const service = createUsersService(db);
    expect(await service.getPrimaryTeammate(undefined, CALLER_PARAMS)).toBeNull();
  });

  dbTest('setPrimaryTeammate records an explicit pick and reads back', async ({ db }) => {
    await ensureCaller(db);
    const branchId = await createBranch(db);
    const service = createUsersService(db);
    const setSpy = vi.spyOn(UserPrimaryTeammateRepository.prototype, 'setPrimaryTeammate');

    const written = await service.setPrimaryTeammate({ branchId }, CALLER_PARAMS);

    expect(written?.branch_id).toBe(branchId);
    expect(setSpy).toHaveBeenCalledWith(CALLER, branchId, {
      source: 'explicit',
      updatedBy: CALLER,
    });
    const resolved = await service.getPrimaryTeammate(undefined, CALLER_PARAMS);
    expect(resolved?.branch_id).toBe(branchId);
    setSpy.mockRestore();
  });

  dbTest('setPrimaryTeammate rejects a branch the caller cannot access', async ({ db }) => {
    await ensureCaller(db);
    const inaccessible = await createBranch(db, {
      created_by: generateId() as UUID,
      others_can: 'none',
    });
    const service = createUsersService(db);

    await expect(
      service.setPrimaryTeammate({ branchId: inaccessible }, CALLER_PARAMS)
    ).rejects.toThrow();
  });

  dbTest('primary teammate methods require an authenticated caller', async ({ db }) => {
    const service = createUsersService(db);
    await expect(service.getPrimaryTeammate(undefined, {} as never)).rejects.toThrow();
    await expect(
      service.setPrimaryTeammate({ branchId: generateId() }, {} as never)
    ).rejects.toThrow();
  });
});
