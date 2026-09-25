import {
  BoardRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  generateId,
  RepoRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserPrimaryTeammateRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { BranchesService } from './branches';
import { UsersService } from './users';

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function seedPreferenceRace(db: TenantScopeAwareDatabase | TenantScopedDatabase) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}@example.test`,
    role: 'member',
    name: 'Keep sibling',
  });
  const board = await new BoardRepository(db).create({
    name: 'Race board',
    created_by: user.user_id,
  });
  const repo = await new RepoRepository(db).create({
    name: 'Race',
    slug: `race-${generateId()}`,
    repo_type: 'local',
    local_path: '/disposable/race',
    default_branch: 'main',
  });
  const branches = new BranchRepository(db);
  const makeBranch = (name: string, branch_unique_id: number) =>
    branches.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      board_id: board.board_id,
      created_by: user.user_id,
      name,
      ref: name,
      path: `/disposable/${generateId()}`,
      branch_unique_id,
      filesystem_status: 'ready',
      custom_context: { teammate: { kind: 'teammate', displayName: name } },
    });
  const branch = await makeBranch('Retiring', 1);
  const replacement = await makeBranch('Replacement', 2);
  await new UserPrimaryTeammateRepository(db).setPrimaryTeammate(user.user_id, branch.branch_id, {
    source: 'explicit',
  });
  return { user, branch, replacement, board };
}

export function retirementService(db: ConstructorParameters<typeof BranchesService>[0]) {
  const app = {
    get: () => ({ execution: {} }),
    emit: vi.fn(),
    service: () => ({
      emit: vi.fn(),
      archiveBranchSessions: vi.fn().mockResolvedValue({ count: 0 }),
    }),
  } as unknown as Application;
  return new BranchesService(db, app);
}

export async function assertPreferenceRace(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  fixture: Awaited<ReturnType<typeof seedPreferenceRace>>,
  remove: 'retirement' | 'self-clear',
  pause: (afterRead: () => Promise<void>) => void,
  peer: (
    work: (db: TenantScopeAwareDatabase | TenantScopedDatabase) => Promise<void>
  ) => Promise<void>
) {
  const { user, branch } = fixture;
  pause(async () => {
    await peer(async (other) => {
      if (remove === 'retirement') {
        // Exercise the atomic persistence owner independently of the service's
        // authority fence, so sibling preservation remains a SQL invariant.
        await new BranchMaintenanceRepository(other).claimForTeammateRetirement(
          branch.branch_id,
          user.user_id,
          async () => {}
        );
      } else {
        await new UsersService(other).setPrimaryTeammate(
          { branchId: null, expectedUserId: user.user_id },
          { user } as AuthenticatedParams
        );
      }
    });
  });
  const result = await new UsersService(db).setPrimaryAgenticToolIfUnset(
    { tool: 'codex', expectedUserId: user.user_id },
    { user } as AuthenticatedParams
  );
  expect(result.primary_teammate_id).toBeUndefined();
  expect(result.primary_agentic_tool).toBe('codex');
  expect(result.name).toBe('Keep sibling');
  expect(
    (await new UsersRepository(db).findById(user.user_id))?.primary_teammate_id
  ).toBeUndefined();
}
