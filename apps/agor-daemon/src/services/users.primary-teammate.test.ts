import {
  BoardRepository,
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
const CALLER_PARAMS = { user: { user_id: CALLER, role: 'member' } } as never;

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
  overrides?: {
    created_by?: UUID;
    others_can?: 'none' | 'view' | 'session';
    teammate?: boolean;
    archived?: boolean;
    board_id?: UUID;
    permission_source?: 'board' | 'override';
  }
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
    board_id: overrides?.board_id,
    created_by: overrides?.created_by ?? CALLER,
    permission_source: overrides?.permission_source ?? 'override',
    others_can: overrides?.others_can ?? 'session',
    archived: overrides?.archived,
    custom_context:
      overrides?.teammate === false ? {} : { teammate: { kind: 'teammate', displayName: name } },
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
    });
    const resolved = await service.getPrimaryTeammate(undefined, CALLER_PARAMS);
    expect(resolved?.branch_id).toBe(branchId);
    setSpy.mockRestore();
  });

  dbTest('onboarding default is set once and never overwrites an explicit pick', async ({ db }) => {
    await ensureCaller(db);
    const onboarding = await createBranch(db);
    const explicit = await createBranch(db);
    const service = createUsersService(db);
    const setSpy = vi.spyOn(UserPrimaryTeammateRepository.prototype, 'setPrimaryTeammateIfUnset');

    await expect(
      service.setPrimaryTeammateIfUnset({ branchId: onboarding }, CALLER_PARAMS)
    ).resolves.toMatchObject({ branch_id: onboarding });
    expect(setSpy).toHaveBeenCalledWith(CALLER, onboarding, {
      source: 'default',
    });

    await service.setPrimaryTeammate({ branchId: explicit }, CALLER_PARAMS);
    await expect(
      service.setPrimaryTeammateIfUnset({ branchId: onboarding }, CALLER_PARAMS)
    ).resolves.toMatchObject({ branch_id: explicit });
    setSpy.mockRestore();
  });

  dbTest(
    'explicit initializer rolls out the board default while the getter remains pure',
    async ({ db }) => {
      const board = await new BoardRepository(db).create({
        board_id: generateId(),
        name: 'Caller board',
        created_by: CALLER,
        access_mode: 'shared',
      });
      const caller = await new UsersRepository(db).create({
        email: 'caller@example.com',
        role: 'member',
        preferences: { mainBoardId: board.board_id },
      });
      const callerParams = { user: { user_id: caller.user_id, role: 'member' } } as never;
      const branchId = await createBranch(db, {
        board_id: board.board_id as UUID,
        permission_source: 'override',
        created_by: caller.user_id as UUID,
      });
      await new BoardRepository(db).setPrimaryTeammate(board.board_id, branchId);

      expect(
        (await new UsersRepository(db).findById(caller.user_id))?.preferences?.mainBoardId
      ).toBe(board.board_id);
      expect((await new BoardRepository(db).findById(board.board_id))?.primary_teammate_id).toBe(
        branchId
      );
      await expect(
        new UserPrimaryTeammateRepository(db).findEligiblePrimaryTeammate(branchId, caller.user_id)
      ).resolves.toMatchObject({ branch_id: branchId });

      const service = createUsersService(db);
      await expect(service.getPrimaryTeammate(undefined, callerParams)).resolves.toBeNull();
      expect(await new UserPrimaryTeammateRepository(db).getBranchId(caller.user_id)).toBeNull();

      await expect(
        service.ensurePrimaryTeammateDefault(undefined, callerParams)
      ).resolves.toMatchObject({ branch_id: branchId });
      expect(await new UserPrimaryTeammateRepository(db).getBranchId(caller.user_id)).toBe(
        branchId
      );
    }
  );

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

  dbTest('setPrimaryTeammate rejects view-only access', async ({ db }) => {
    await ensureCaller(db);
    const branchId = await createBranch(db, {
      created_by: generateId() as UUID,
      others_can: 'view',
    });

    await expect(
      createUsersService(db).setPrimaryTeammate({ branchId }, CALLER_PARAMS)
    ).rejects.toThrow(/create sessions/);
  });

  dbTest('getPrimaryTeammateCandidates uses session eligibility', async ({ db }) => {
    await ensureCaller(db);
    const eligible = await createBranch(db);
    await createBranch(db, {
      created_by: generateId() as UUID,
      others_can: 'view',
    });
    await createBranch(db, { teammate: false });
    await createBranch(db, { archived: true });

    await expect(
      createUsersService(db).getPrimaryTeammateCandidates(undefined, CALLER_PARAMS)
    ).resolves.toEqual([expect.objectContaining({ branch_id: eligible })]);
  });

  dbTest('viewers cannot list or set primary teammate choices', async ({ db }) => {
    await ensureCaller(db);
    const branchId = await createBranch(db);
    const viewerParams = { user: { user_id: CALLER, role: 'viewer' } } as never;
    const service = createUsersService(db);

    await expect(service.getPrimaryTeammateCandidates(undefined, viewerParams)).rejects.toThrow(
      /Member role/
    );
    await expect(service.ensurePrimaryTeammateDefault(undefined, viewerParams)).rejects.toThrow(
      /Member role/
    );
    await expect(service.setPrimaryTeammate({ branchId }, viewerParams)).rejects.toThrow(
      /Member role/
    );
    await expect(service.setPrimaryTeammateIfUnset({ branchId }, viewerParams)).rejects.toThrow(
      /Member role/
    );
  });

  dbTest('setPrimaryTeammate rejects non-teammate and archived branches', async ({ db }) => {
    await ensureCaller(db);
    const ordinaryBranch = await createBranch(db, { teammate: false });
    const archivedTeammate = await createBranch(db, { archived: true });
    const service = createUsersService(db);

    await expect(
      service.setPrimaryTeammate({ branchId: ordinaryBranch }, CALLER_PARAMS)
    ).rejects.toThrow(/active teammate/);
    await expect(
      service.setPrimaryTeammate({ branchId: archivedTeammate }, CALLER_PARAMS)
    ).rejects.toThrow(/active teammate/);
  });

  dbTest(
    'open-access mode permits any active teammate regardless of branch ACL',
    async ({ db }) => {
      await ensureCaller(db);
      const branchId = await createBranch(db, {
        created_by: generateId() as UUID,
        others_can: 'none',
      });
      const app = {
        get: () => ({ execution: { branch_rbac: false } }),
        service: () => ({ emit: vi.fn() }),
      } as never;
      const service = createUsersService(db, app);

      await expect(service.setPrimaryTeammate({ branchId }, CALLER_PARAMS)).resolves.toMatchObject({
        branch_id: branchId,
      });
      await expect(service.getPrimaryTeammate(undefined, CALLER_PARAMS)).resolves.toMatchObject({
        branch_id: branchId,
      });
    }
  );

  dbTest('primary teammate methods require an authenticated caller', async ({ db }) => {
    const service = createUsersService(db);
    await expect(service.getPrimaryTeammate(undefined, {} as never)).rejects.toThrow();
    await expect(service.ensurePrimaryTeammateDefault(undefined, {} as never)).rejects.toThrow();
    await expect(service.getPrimaryTeammateCandidates(undefined, {} as never)).rejects.toThrow();
    await expect(
      service.setPrimaryTeammate({ branchId: generateId() }, {} as never)
    ).rejects.toThrow();
    await expect(
      service.setPrimaryTeammateIfUnset({ branchId: generateId() }, {} as never)
    ).rejects.toThrow();
  });
});
