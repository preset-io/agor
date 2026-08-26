import type {
  BranchID,
  CapabilityPolicyFsAccess,
  CapabilityPolicyPresetId,
  GroupID,
  UserID,
  UUID,
} from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { capabilityPolicyPresetCapabilities } from '../../types/capability-policy';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { CapabilityPolicyRepository } from './capability-policies';
import { GroupRepository } from './groups';
import { RepoRepository } from './repos';
import { ScheduleRepository } from './schedules';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

async function makeUser(repo: UsersRepository, email: string): Promise<UserID> {
  return (
    await repo.create({
      email,
      name: email,
      role: 'member',
    })
  ).user_id as UserID;
}

async function setBranchGroupEntry(
  db: Database,
  branchId: BranchID,
  actorId: UserID,
  groupId: GroupID,
  preset: CapabilityPolicyPresetId,
  fsAccess: CapabilityPolicyFsAccess = 'none'
): Promise<void> {
  const policies = new CapabilityPolicyRepository(db);
  const current = await policies.getBranchPolicy(branchId);
  const base =
    current.binding_mode === 'inherit' ? current.inherited_config : current.override_config;
  if (!base) throw new Error('branch has no effective policy');
  const capabilities = capabilityPolicyPresetCapabilities('branch_access', preset, fsAccess);
  if (!capabilities) throw new Error(`invalid test preset: ${preset}`);
  await policies.replaceBranchPolicy(
    branchId,
    {
      ...current,
      binding_mode: 'override',
      override_config: {
        ...base,
        access: {
          ...base.access,
          sharing_mode: 'shared',
          entries: [
            {
              entry_id: generateId() as UUID,
              principal: { principal_type: 'group', group_id: groupId },
              preset,
              capabilities,
              fs_access: fsAccess,
            },
          ],
        },
      },
    },
    actorId
  );
}

describe('normalized group-backed capability policies', () => {
  dbTest('resolves a group entry and the set-based branch list identically', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);
    const ownerId = await makeUser(users, 'owner@example.com');
    const memberId = await makeUser(users, 'member@example.com');
    const repo = await repos.create({
      name: 'group-policy-repo',
      slug: 'group-policy-repo',
      repo_type: 'local',
      local_path: '/tmp/group-policy-repo',
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-000000000001' as BranchID,
      repo_id: repo.repo_id,
      name: 'private-branch',
      ref: 'private-branch',
      path: '/tmp/group-policy-repo/private-branch',
      created_by: ownerId as UUID,
      branch_unique_id: 1,
      new_branch: true,
      others_can: 'none',
    });
    const group = await groups.create({ name: 'Engineering', created_by: ownerId });
    await groups.addMember(group.group_id, memberId, ownerId);
    await setBranchGroupEntry(
      db,
      branch.branch_id,
      ownerId,
      group.group_id,
      'collaborator',
      'read'
    );

    await expect(branches.resolveUserPermission(branch, memberId as UUID)).resolves.toBe('session');
    const accessible = await branches.findAccessibleBranches(memberId as UUID, { archived: false });
    expect(accessible.map((candidate) => candidate.branch_id)).toContain(branch.branch_id);
  });

  dbTest('group membership changes take effect without rewriting policies', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);
    const ownerId = await makeUser(users, 'owner-membership@example.com');
    const memberId = await makeUser(users, 'member-membership@example.com');
    const repo = await repos.create({
      name: 'membership-repo',
      slug: 'membership-repo',
      repo_type: 'local',
      local_path: '/tmp/membership-repo',
      default_branch: 'main',
    });
    const branch = await branches.create({
      repo_id: repo.repo_id,
      name: 'membership-branch',
      ref: 'membership-branch',
      path: '/tmp/membership-repo/membership-branch',
      created_by: ownerId as UUID,
      branch_unique_id: 2,
      new_branch: true,
      others_can: 'none',
    });
    const group = await groups.create({ name: 'Runtime Team', created_by: ownerId });
    await setBranchGroupEntry(db, branch.branch_id, ownerId, group.group_id, 'viewer');

    await expect(branches.resolveUserPermission(branch, memberId as UUID)).resolves.toBe('none');
    await groups.addMember(group.group_id, memberId, ownerId);
    await expect(branches.resolveUserPermission(branch, memberId as UUID)).resolves.toBe('view');
    await groups.removeMember(group.group_id, memberId);
    await expect(branches.resolveUserPermission(branch, memberId as UUID)).resolves.toBe('none');
  });

  dbTest(
    'archived groups stop contributing to point and nested-resource list access',
    async ({ db }) => {
      const users = new UsersRepository(db);
      const repos = new RepoRepository(db);
      const branches = new BranchRepository(db);
      const groups = new GroupRepository(db);
      const sessions = new SessionRepository(db);
      const schedules = new ScheduleRepository(db);
      const ownerId = await makeUser(users, 'owner-archived@example.com');
      const memberId = await makeUser(users, 'member-archived@example.com');
      const repo = await repos.create({
        name: 'archived-repo',
        slug: 'archived-repo',
        repo_type: 'local',
        local_path: '/tmp/archived-repo',
        default_branch: 'main',
      });
      const branch = await branches.create({
        repo_id: repo.repo_id,
        name: 'archived-group-branch',
        ref: 'archived-group-branch',
        path: '/tmp/archived-repo/archived-group-branch',
        created_by: ownerId as UUID,
        branch_unique_id: 3,
        new_branch: true,
        others_can: 'none',
      });
      const session = await sessions.create({
        branch_id: branch.branch_id,
        created_by: ownerId as UUID,
        agentic_tool: 'claude-code',
      });
      const schedule = await schedules.create({
        branch_id: branch.branch_id,
        created_by: ownerId as UUID,
        name: 'Archived group schedule',
        cron_expression: '0 * * * *',
        timezone_mode: 'utc',
        prompt: 'Archived group',
        agentic_tool_config: { agentic_tool: 'claude-code' },
      });
      const group = await groups.create({ name: 'Archived Team', created_by: ownerId });
      await groups.addMember(group.group_id, memberId, ownerId);
      await setBranchGroupEntry(db, branch.branch_id, ownerId, group.group_id, 'manager', 'write');
      await groups.update(group.group_id, { archived: true });

      await expect(branches.resolveUserPermission(branch, memberId as UUID)).resolves.toBe('none');
      expect(
        (await branches.findAccessibleBranches(memberId as UUID)).map((item) => item.branch_id)
      ).not.toContain(branch.branch_id);
      expect(
        (await sessions.findAccessibleSessions(memberId as UUID)).map((item) => item.session_id)
      ).not.toContain(session.session_id);
      expect(
        (await schedules.findAccessibleSchedules(memberId as UUID)).map((item) => item.schedule_id)
      ).not.toContain(schedule.schedule_id);
    }
  );

  dbTest('a branch group entry does not implicitly reveal its board', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const boards = new BoardRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);
    const ownerId = await makeUser(users, 'owner-board-boundary@example.com');
    const memberId = await makeUser(users, 'member-board-boundary@example.com');
    const repo = await repos.create({
      name: 'board-boundary-repo',
      slug: 'board-boundary-repo',
      repo_type: 'local',
      local_path: '/tmp/board-boundary-repo',
      default_branch: 'main',
    });
    const board = await boards.create({
      name: 'Private board boundary',
      created_by: ownerId as UUID,
      access_mode: 'private',
    });
    const branch = await branches.create({
      repo_id: repo.repo_id,
      board_id: board.board_id,
      permission_binding: 'override',
      name: 'visible-branch-hidden-board',
      ref: 'visible-branch-hidden-board',
      path: '/tmp/board-boundary-repo/visible-branch-hidden-board',
      created_by: ownerId as UUID,
      branch_unique_id: 4,
      new_branch: true,
      others_can: 'none',
    });
    const group = await groups.create({ name: 'Branch Readers', created_by: ownerId });
    await groups.addMember(group.group_id, memberId, ownerId);
    await setBranchGroupEntry(db, branch.branch_id, ownerId, group.group_id, 'viewer');

    expect(
      (await branches.findAccessibleBranches(memberId as UUID)).map((item) => item.branch_id)
    ).toContain(branch.branch_id);
    expect(await boards.findVisibleBoardIds(memberId as UUID)).not.toContain(board.board_id);
  });
});
