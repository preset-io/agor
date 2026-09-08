import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type {
  BoardPolicyCapability,
  BranchID,
  BranchPolicyCapability,
  CapabilityPolicyEntry,
  CapabilityPolicyFsAccess,
  CapabilityPolicyKind,
  CapabilityPolicyPresetId,
} from '../../types';
import {
  BOARD_POLICY_CAPABILITIES,
  BRANCH_POLICY_CAPABILITIES,
  capabilityPolicyPresetCapabilities,
} from '../../types/capability-policy';
import type { Database } from '../client';
import { select } from '../database-wrapper';
import { boards, branches } from '../schema';
import { BoardRepository } from './boards';
import { boardCapabilityCondition, branchCapabilityCondition } from './branch-access';
import { BranchRepository } from './branches';
import { CapabilityPolicyRepository } from './capability-policies';
import { GroupRepository } from './groups';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

/** Same persisted-policy matrix on SQLite and PostgreSQL under tenant RLS. */
export async function exerciseCapabilityPredicateParity(db: Database) {
  const userRepo = new UsersRepository(db);
  const owner = (
    await userRepo.create({ email: `${generateId()}@example.invalid`, role: 'member' })
  ).user_id;
  const member = (
    await userRepo.create({ email: `${generateId()}@example.invalid`, role: 'member' })
  ).user_id;
  const admin = (await userRepo.create({ email: `${generateId()}@example.invalid`, role: 'admin' }))
    .user_id;
  const groupRepo = new GroupRepository(db);
  const work = await groupRepo.create({ name: `Work-${generateId()}`, created_by: owner });
  const files = await groupRepo.create({ name: `Files-${generateId()}`, created_by: owner });
  for (const group of [work, files]) await groupRepo.addMember(group.group_id, member, owner);
  const board = await new BoardRepository(db).create({
    name: 'Capability parity',
    created_by: owner,
    access_mode: 'private',
  });
  const repo = await new RepoRepository(db).create({
    slug: `capability-parity-${generateId()}`,
    name: 'Parity',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/parity.git',
    local_path: '/tmp/capability-parity',
    default_branch: 'main',
  });
  const branchRepo = new BranchRepository(db);
  const branchIds: BranchID[] = [];
  for (const [i, binding] of (['inherit', 'override'] as const).entries()) {
    branchIds.push(
      (
        await branchRepo.create({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          created_by: owner,
          name: binding,
          ref: binding,
          path: `/tmp/capability-parity/${binding}`,
          branch_unique_id: i,
          permission_binding: binding,
        })
      ).branch_id
    );
  }
  const policyRepo = new CapabilityPolicyRepository(db);
  const grant = (
    kind: CapabilityPolicyKind,
    preset: CapabilityPolicyPresetId,
    fs_access: CapabilityPolicyFsAccess = 'none'
  ) => {
    const capabilities = capabilityPolicyPresetCapabilities(kind, preset, fs_access);
    if (!capabilities) throw new Error('Invalid test role');
    return { preset, capabilities, fs_access };
  };
  const entry = (
    principal: CapabilityPolicyEntry['principal'],
    value: ReturnType<typeof grant>
  ): CapabilityPolicyEntry => ({
    entry_id: generateId(),
    principal,
    ...value,
  });
  const direct = { principal_type: 'user', user_id: member } as const;
  const workGroup = { principal_type: 'group', group_id: work.group_id } as const;
  const fileGroup = { principal_type: 'group', group_id: files.group_id } as const;

  async function verify(label: string) {
    for (const userId of [owner, member, admin]) {
      // Admin is intentionally just a principal here: bypass belongs to the
      // trusted service boundary, never to these reusable SQL predicates.
      const boardPoint = await policyRepo.resolveBoardAccess(board.board_id, userId);
      const boardSql = await select(
        db,
        Object.fromEntries(
          BOARD_POLICY_CAPABILITIES.map((capability) => [
            capability,
            sql`CASE WHEN ${boardCapabilityCondition(db, userId, capability)} THEN 1 ELSE 0 END`,
          ])
        )
      )
        .from(boards)
        .where(eq(boards.board_id, board.board_id))
        .one();
      for (const capability of BOARD_POLICY_CAPABILITIES) {
        expect(Boolean(boardSql[capability]), `${label}: board ${capability}`).toBe(
          boardPoint.capabilities.includes(capability)
        );
      }
      for (const branchId of branchIds) {
        const point = await policyRepo.resolveBranchAccess(branchId, userId);
        const row = await select(
          db,
          Object.fromEntries(
            BRANCH_POLICY_CAPABILITIES.map((capability) => [
              capability,
              sql`CASE WHEN ${branchCapabilityCondition(db, userId, capability)} THEN 1 ELSE 0 END`,
            ])
          )
        )
          .from(branches)
          .where(eq(branches.branch_id, branchId))
          .one();
        for (const capability of BRANCH_POLICY_CAPABILITIES) {
          expect(Boolean(row[capability]), `${label}: branch ${capability}`).toBe(
            point.capabilities.includes(capability)
          );
        }
      }
    }
  }

  async function replaceBranch(
    entries: CapabilityPolicyEntry[],
    others = grant('branch_access', 'manager', 'write')
  ) {
    const config = {
      access: {
        schema_version: 1 as const,
        policy_kind: 'branch_access' as const,
        sharing_mode: 'shared' as const,
        entries,
        others,
      },
      allow_shared_session_prompts: false,
    };
    const currentBoard = await policyRepo.getBoardPolicies(board.board_id);
    await policyRepo.replaceBoardPolicies(
      board.board_id,
      { ...currentBoard, branch_template: config },
      owner
    );
    const currentBranch = await policyRepo.getBranchPolicy(branchIds[1]);
    await policyRepo.replaceBranchPolicy(
      branchIds[1],
      { ...currentBranch, override_config: config },
      owner
    );
  }

  await verify('private');
  // Runtime callers cannot turn an unknown capability into an owner bypass.
  expect(
    await select(db)
      .from(boards)
      .where(boardCapabilityCondition(db, owner, 'invalid' as BoardPolicyCapability))
      .all()
  ).toEqual([]);
  expect(
    await select(db)
      .from(branches)
      .where(branchCapabilityCondition(db, owner, 'invalid' as BranchPolicyCapability))
      .all()
  ).toEqual([]);
  for (const preset of ['none', 'viewer', 'editor', 'manager'] as const) {
    for (const source of ['direct', 'group', 'others'] as const) {
      const current = await policyRepo.getBoardPolicies(board.board_id);
      current.board_access.sharing_mode = 'shared';
      current.board_access.others = grant('board_access', source === 'others' ? preset : 'manager');
      current.board_access.entries =
        source === 'others'
          ? []
          : [entry(source === 'direct' ? direct : workGroup, grant('board_access', preset))];
      if (source === 'direct')
        current.board_access.entries.push(entry(workGroup, grant('board_access', 'manager')));
      await policyRepo.replaceBoardPolicies(board.board_id, current, owner);
      await verify(`board ${source} ${preset}`);
    }
  }
  for (const preset of ['none', 'viewer', 'collaborator', 'manager'] as const) {
    for (const fs of ['none', 'read', 'write'] as const) {
      if (preset === 'none' && fs !== 'none') continue; // Invalid persisted policy, not an authorization case.
      for (const source of ['direct', 'group', 'others'] as const) {
        const value = grant('branch_access', preset, fs);
        const entries =
          source === 'others' ? [] : [entry(source === 'direct' ? direct : workGroup, value)];
        if (source === 'direct')
          entries.push(entry(workGroup, grant('branch_access', 'manager', 'write')));
        await replaceBranch(entries, source === 'others' ? value : undefined);
        await verify(`branch ${source} ${preset}/${fs}`);
      }
    }
  }
  // Role and filesystem dimensions may come from DIFFERENT active groups.
  const currentBoard = await policyRepo.getBoardPolicies(board.board_id);
  currentBoard.board_access.entries = [
    entry(workGroup, grant('board_access', 'editor')),
    entry(fileGroup, grant('board_access', 'viewer')),
  ];
  currentBoard.board_access.others = grant('board_access', 'none');
  await policyRepo.replaceBoardPolicies(board.board_id, currentBoard, owner);
  await replaceBranch(
    [
      entry(workGroup, grant('branch_access', 'collaborator')),
      entry(fileGroup, grant('branch_access', 'viewer', 'read')),
    ],
    grant('branch_access', 'none')
  );
  await verify('split group dimensions');
  expect((await policyRepo.resolveBranchAccess(branchIds[0], member)).capabilities).toContain(
    'terminal.open'
  );
  await groupRepo.update(files.group_id, { archived: true });
  await verify('archived filesystem group');
  expect((await policyRepo.resolveBranchAccess(branchIds[0], member)).capabilities).not.toContain(
    'terminal.open'
  );
  await groupRepo.update(files.group_id, { archived: false });
  await groupRepo.removeMember(work.group_id, member);
  await verify('removed role membership');
  expect((await policyRepo.resolveBranchAccess(branchIds[0], member)).capabilities).toEqual([
    'branch.view',
  ]);
  await groupRepo.removeMember(files.group_id, member);
  await verify('no matching groups');
  expect((await policyRepo.resolveBranchAccess(branchIds[0], member)).capabilities).toEqual([]);
  return { owner, member, admin, boardId: board.board_id, branchId: branchIds[0] };
}
