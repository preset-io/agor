import type { BranchID, UserID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../test-helpers';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { GroupRepository } from './groups';
import { RepoRepository } from './repos';
import { ScheduleRepository } from './schedules';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

const PERMISSION_RANK = {
  none: -1,
  view: 0,
  session: 1,
  prompt: 2,
  all: 3,
} as const;

async function makeUser(repo: UsersRepository, email: string): Promise<UserID> {
  const user = await repo.create({
    email,
    name: email,
    role: 'member',
  });
  return user.user_id as UserID;
}

describe('GroupRepository branch grants', () => {
  dbTest('resolves branch access through group membership', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);

    const ownerId = await makeUser(users, 'owner@example.com');
    const memberId = await makeUser(users, 'member@example.com');

    const repo = await repos.create({
      name: 'test-repo',
      slug: 'test-repo',
      repo_type: 'local',
      local_path: '/tmp/test-repo',
      default_branch: 'main',
    });

    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-000000000001' as BranchID,
      repo_id: repo.repo_id,
      name: 'private-branch',
      ref: 'private-branch',
      path: '/tmp/test-repo/private-branch',
      created_by: ownerId as UUID,
      branch_unique_id: 1,
      new_branch: true,
      others_can: 'none',
    });

    const group = await groups.create({ name: 'Engineering', created_by: ownerId });
    await groups.addMember(group.group_id, memberId, ownerId);
    await groups.upsertBranchGrant({
      branch_id: branch.branch_id,
      group_id: group.group_id,
      can: 'session',
      created_by: ownerId,
    });

    await expect(branches.resolveUserPermission(branch, memberId as UUID)).resolves.toBe('session');
    const accessible = await branches.findAccessibleBranches(memberId as UUID, { archived: false });
    expect(accessible.map((b) => b.branch_id as BranchID)).toContain(branch.branch_id);
  });

  dbTest('does not treat none group grants as visible branch access', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const boards = new BoardRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);
    const sessions = new SessionRepository(db);
    const schedules = new ScheduleRepository(db);

    const ownerId = await makeUser(users, 'owner-none@example.com');
    const memberId = await makeUser(users, 'member-none@example.com');

    const repo = await repos.create({
      name: 'none-grant-repo',
      slug: 'none-grant-repo',
      repo_type: 'local',
      local_path: '/tmp/none-grant-repo',
      default_branch: 'main',
    });
    const board = await boards.create({
      name: 'Private none grant board',
      created_by: ownerId as UUID,
    });

    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-000000000002' as BranchID,
      repo_id: repo.repo_id,
      name: 'private-none-grant',
      ref: 'private-none-grant',
      path: '/tmp/none-grant-repo/private-none-grant',
      created_by: ownerId as UUID,
      branch_unique_id: 2,
      new_branch: true,
      others_can: 'none',
      board_id: board.board_id,
    });

    const session = await sessions.create({
      branch_id: branch.branch_id,
      created_by: ownerId as UUID,
      agentic_tool: 'claude-code',
    });
    const schedule = await schedules.create({
      branch_id: branch.branch_id,
      created_by: ownerId as UUID,
      name: 'Private schedule',
      cron_expression: '0 * * * *',
      timezone_mode: 'utc',
      prompt: 'Private',
      agentic_tool_config: { agentic_tool: 'claude-code' },
    });

    const group = await groups.create({ name: 'No Access', created_by: ownerId });
    await groups.addMember(group.group_id, memberId, ownerId);
    await groups.upsertBranchGrant({
      branch_id: branch.branch_id,
      group_id: group.group_id,
      can: 'none',
      created_by: ownerId,
    });

    await expect(branches.resolveUserPermission(branch, memberId as UUID)).resolves.toBe('none');

    const accessibleBranches = await branches.findAccessibleBranches(memberId as UUID, {
      archived: false,
    });
    expect(accessibleBranches.map((b) => b.branch_id)).not.toContain(branch.branch_id);

    const accessibleSessions = await sessions.findAccessibleSessions(memberId as UUID);
    expect(accessibleSessions.map((s) => s.session_id)).not.toContain(session.session_id);

    const accessibleSchedules = await schedules.findAccessibleSchedules(memberId as UUID);
    expect(accessibleSchedules.map((s) => s.schedule_id)).not.toContain(schedule.schedule_id);

    const visibleBoards = await boards.findVisibleBoardIds(memberId as UUID);
    expect(visibleBoards).not.toContain(board.board_id);
  });

  dbTest('keeps evaluator and optimized list queries in sync for group grants', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const boards = new BoardRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);
    const sessions = new SessionRepository(db);
    const schedules = new ScheduleRepository(db);

    const ownerId = await makeUser(users, 'owner-parity@example.com');
    const memberId = await makeUser(users, 'member-parity@example.com');

    const repo = await repos.create({
      name: 'parity-repo',
      slug: 'parity-repo',
      repo_type: 'local',
      local_path: '/tmp/parity-repo',
      default_branch: 'main',
    });
    const group = await groups.create({ name: 'Parity Team', created_by: ownerId });
    await groups.addMember(group.group_id, memberId, ownerId);

    const cases = [
      { name: 'fallback-none-grant-none', others_can: 'none', group_can: 'none' },
      { name: 'fallback-none-grant-view', others_can: 'none', group_can: 'view' },
      { name: 'fallback-none-grant-session', others_can: 'none', group_can: 'session' },
      { name: 'fallback-none-grant-prompt', others_can: 'none', group_can: 'prompt' },
      { name: 'fallback-none-grant-all', others_can: 'none', group_can: 'all' },
      { name: 'fallback-session-grant-none', others_can: 'session', group_can: 'none' },
    ] as const;

    const created = [];
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index];
      const board = await boards.create({
        name: `Parity board ${testCase.name}`,
        created_by: ownerId as UUID,
      });
      const branch = await branches.create({
        branch_id: `019f0000-0000-7000-8000-00000000010${index}` as BranchID,
        repo_id: repo.repo_id,
        name: testCase.name,
        ref: testCase.name,
        path: `/tmp/parity-repo/${testCase.name}`,
        created_by: ownerId as UUID,
        branch_unique_id: 10 + index,
        new_branch: true,
        others_can: testCase.others_can,
        board_id: board.board_id,
      });
      await groups.upsertBranchGrant({
        branch_id: branch.branch_id,
        group_id: group.group_id,
        can: testCase.group_can,
        created_by: ownerId,
      });
      const session = await sessions.create({
        branch_id: branch.branch_id,
        created_by: ownerId as UUID,
        agentic_tool: 'claude-code',
      });
      const schedule = await schedules.create({
        branch_id: branch.branch_id,
        created_by: ownerId as UUID,
        name: `Schedule ${testCase.name}`,
        cron_expression: '0 * * * *',
        timezone_mode: 'utc',
        prompt: 'Parity',
        agentic_tool_config: { agentic_tool: 'claude-code' },
      });
      const effective = await branches.resolveUserPermission(branch, memberId as UUID);
      const shouldBeVisible = PERMISSION_RANK[effective] >= PERMISSION_RANK.view;
      created.push({ branch, session, schedule, board, shouldBeVisible });
    }

    const accessibleBranches = new Set(
      (await branches.findAccessibleBranches(memberId as UUID)).map((b) => b.branch_id)
    );
    const accessibleSessions = new Set(
      (await sessions.findAccessibleSessions(memberId as UUID)).map((s) => s.session_id)
    );
    const accessibleSchedules = new Set(
      (await schedules.findAccessibleSchedules(memberId as UUID)).map((s) => s.schedule_id)
    );
    const visibleBoards = new Set(await boards.findVisibleBoardIds(memberId as UUID));

    for (const item of created) {
      expect(accessibleBranches.has(item.branch.branch_id)).toBe(item.shouldBeVisible);
      expect(accessibleSessions.has(item.session.session_id)).toBe(item.shouldBeVisible);
      expect(accessibleSchedules.has(item.schedule.schedule_id)).toBe(item.shouldBeVisible);
      expect(visibleBoards.has(item.board.board_id)).toBe(item.shouldBeVisible);
    }
  });
});
