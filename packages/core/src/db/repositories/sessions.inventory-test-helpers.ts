import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import {
  type BranchID,
  type CapabilityPolicyEntry,
  type Message,
  MessageRole,
  type Task,
  TaskStatus,
  type UserID,
} from '../../types';
import type { Database } from '../client';
import { select } from '../database-wrapper';
import { branches as branchTable, users as userTable } from '../schema';
import { BoardRepository } from './boards';
import {
  inVisibleBranchSet,
  visibleBranchAccessCondition,
  visibleBranchReferenceAccessExists,
} from './branch-access';
import { BranchRepository } from './branches';
import { CapabilityPolicyRepository } from './capability-policies';
import { GroupRepository } from './groups';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

/** Same inventory authorization contract exercised on SQLite and PostgreSQL/RLS. */
export async function exerciseSessionInventory(db: Database) {
  const users = new UsersRepository(db);
  const owner = (await users.create({ email: `${generateId()}@example.invalid`, role: 'member' }))
    .user_id as UserID;
  const viewer = (await users.create({ email: `${generateId()}@example.invalid`, role: 'member' }))
    .user_id as UserID;
  const admin = (await users.create({ email: `${generateId()}@example.invalid`, role: 'admin' }))
    .user_id as UserID;
  const boards = new BoardRepository(db);
  const board = await boards.create({
    name: 'Private canvas',
    created_by: owner,
    access_mode: 'private',
  });
  const sharedBoard = await boards.create({
    name: 'Shared canvas',
    created_by: owner,
    access_mode: 'shared',
  });
  const repo = await new RepoRepository(db).create({
    slug: `inventory-${generateId()}`,
    name: 'Inventory',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/inventory.git',
    local_path: '/tmp/inventory',
    default_branch: 'main',
  });
  const groups = new GroupRepository(db);
  const group = await groups.create({ name: 'Readers', created_by: owner });
  await groups.addMember(group.group_id, viewer, owner);
  const groupEntry: CapabilityPolicyEntry = {
    entry_id: generateId(),
    principal: { principal_type: 'group', group_id: group.group_id },
    preset: 'viewer',
    capabilities: ['branch.view'],
    fs_access: 'none',
  };
  const deniedEntry: CapabilityPolicyEntry = {
    entry_id: generateId(),
    principal: { principal_type: 'user', user_id: viewer },
    preset: 'none',
    capabilities: [],
    fs_access: 'none',
  };
  const policies = new CapabilityPolicyRepository(db);
  const branches = new BranchRepository(db);
  const sessions = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const messageRepo = new MessagesRepository(db);
  const childTasks: Task[] = [];
  const childMessages: Message[] = [];
  const visible = new Set<string>();
  const all = new Set<string>();
  const branchIds: BranchID[] = [];
  let groupedBranch!: BranchID;
  let hiddenBranch!: BranchID;
  let shadowBranch!: BranchID;
  for (const [i, kind] of [
    'private',
    'others',
    'group',
    'shadow',
    'group-deny',
    'direct',
    'inherit',
  ].entries()) {
    const branch = await branches.create({
      repo_id: repo.repo_id,
      board_id: kind === 'private' ? sharedBoard.board_id : board.board_id,
      created_by: owner,
      name: kind,
      ref: kind,
      path: `/tmp/inventory/${kind}`,
      branch_unique_id: i,
      permission_binding: kind === 'inherit' ? 'inherit' : 'override',
    });
    branchIds.push(branch.branch_id);
    if (kind === 'group') groupedBranch = branch.branch_id;
    if (kind === 'private') hiddenBranch = branch.branch_id;
    if (kind === 'shadow') shadowBranch = branch.branch_id;
    const policy = await policies.getBranchPolicy(branch.branch_id);
    const config = policy.override_config ?? policy.inherited_config!;
    config.access.sharing_mode = kind === 'private' ? 'private' : 'shared';
    config.access.others = {
      preset: ['private', 'group'].includes(kind) ? 'none' : 'viewer',
      capabilities: ['private', 'group'].includes(kind) ? [] : ['branch.view'],
      fs_access: 'none',
    };
    config.access.entries =
      kind === 'group'
        ? [groupEntry]
        : kind === 'shadow'
          ? [groupEntry, deniedEntry]
          : kind === 'group-deny'
            ? [{ ...groupEntry, preset: 'none', capabilities: [] }]
            : kind === 'direct'
              ? [{ ...deniedEntry, preset: 'viewer', capabilities: ['branch.view'] }]
              : [];
    if (kind === 'inherit') {
      const boardPolicy = await policies.getBoardPolicies(board.board_id);
      await policies.replaceBoardPolicies(
        board.board_id,
        { ...boardPolicy, branch_template: config },
        owner
      );
    } else {
      await policies.replaceBranchPolicy(
        branch.branch_id,
        { ...policy, override_config: config },
        owner
      );
    }
    for (let n = 0; n < 4; n++) {
      const session = await sessions.create({
        branch_id: branch.branch_id,
        created_by: owner,
        status: n === 2 ? 'running' : 'idle',
        archived: n === 3,
        created_at: new Date(1700000000000 + n).toISOString(),
        title: `${kind}-${n}`,
        custom_context: { inventory: true },
        sdk_home_scope: 'branch',
      });
      const task = await taskRepo.create({
        session_id: session.session_id,
        created_by: owner,
        status: n % 2 ? TaskStatus.COMPLETED : TaskStatus.CREATED,
        full_prompt: 'Inventory child',
      });
      childTasks.push(task);
      childMessages.push(
        await messageRepo.create({
          session_id: session.session_id,
          task_id: task.task_id,
          type: n % 2 ? 'assistant' : 'user',
          role: n % 2 ? MessageRole.ASSISTANT : MessageRole.USER,
          index: 0,
          timestamp: session.created_at,
          content: 'Inventory child',
          content_preview: 'Inventory child',
        })
      );
      all.add(session.session_id);
      if (!['private', 'shadow', 'group-deny'].includes(kind)) visible.add(session.session_id);
    }
  }
  // Differential proof: SQL inventory, exact reference, and rich point checks
  // answer the same visibility question for an existing authenticated principal.
  async function verifyPrimitiveParity(userId: UserID) {
    const rowIds: { id: BranchID }[] = await select(db, { id: branchTable.branch_id })
      .from(branchTable)
      .where(visibleBranchAccessCondition(db, userId))
      .all();
    const setIds: { id: BranchID }[] = await select(db, { id: branchTable.branch_id })
      .from(branchTable)
      .where(inVisibleBranchSet(db, userId, branchTable.branch_id))
      .all();
    expect(new Set(setIds.map((row) => row.id))).toEqual(new Set(rowIds.map((row) => row.id)));
    for (const branchId of branchIds) {
      const visible = setIds.some((row) => row.id === branchId);
      const exact = await select(db, {
        allowed: visibleBranchReferenceAccessExists(db, userId, sql`${branchId}`),
      })
        .from(userTable)
        .where(eq(userTable.user_id, userId))
        .one();
      expect(Boolean(exact?.allowed)).toBe(visible);
      expect(
        (await policies.resolveBranchAccess(branchId, userId)).capabilities.includes('branch.view')
      ).toBe(visible);
    }
    const paged = await sessions.findPage({ visibleToUserId: userId, limit: 100 });
    const expectedIds = new Set(paged.data.map((row) => row.session_id));
    expect(
      new Set((await sessions.findAll({ visibleToUserId: userId })).map((row) => row.session_id))
    ).toEqual(expectedIds);
    expect(
      new Set((await sessions.findAccessibleSessions(userId)).map((row) => row.session_id))
    ).toEqual(expectedIds);
    // Child inventories reuse the session-reference predicate. Keep all/page/
    // count/projection semantics aligned with the same currently visible set.
    const expectedTasks = childTasks
      .filter((row) => expectedIds.has(row.session_id))
      .sort((a, b) => a.task_id.localeCompare(b.task_id));
    const expectedMessages = childMessages
      .filter((row) => expectedIds.has(row.session_id))
      .sort((a, b) => a.message_id.localeCompare(b.message_id));
    expect(
      new Set((await taskRepo.findAll({ visibleToUserId: userId })).map((row) => row.task_id))
    ).toEqual(new Set(expectedTasks.map((row) => row.task_id)));
    expect(
      new Set((await messageRepo.findAll({ visibleToUserId: userId })).map((row) => row.message_id))
    ).toEqual(new Set(expectedMessages.map((row) => row.message_id)));
    expect(
      await taskRepo.findPage({
        visibleToUserId: userId,
        limit: 2,
        skip: 1,
        sort: { task_id: 1 },
        selectTaskIdOnly: true,
      })
    ).toEqual({
      total: expectedTasks.length,
      data: expectedTasks.slice(1, 3).map((row) => ({ task_id: row.task_id })),
    });
    expect(
      await messageRepo.findPage({
        visibleToUserId: userId,
        limit: 2,
        skip: 1,
        sort: { message_id: 1 },
        select: ['message_id'],
      })
    ).toEqual({
      total: expectedMessages.length,
      data: expectedMessages.slice(1, 3).map((row) => ({ message_id: row.message_id })),
    });
    expect(
      await taskRepo.findPage({ visibleToUserId: userId, limit: 0, status: TaskStatus.COMPLETED })
    ).toEqual({
      total: expectedTasks.filter((row) => row.status === TaskStatus.COMPLETED).length,
      data: [],
    });
    expect(
      await messageRepo.findPage({ visibleToUserId: userId, limit: 0, role: MessageRole.ASSISTANT })
    ).toEqual({
      total: expectedMessages.filter((row) => row.role === MessageRole.ASSISTANT).length,
      data: [],
    });
    const visibleChild = expectedTasks[0];
    const hiddenChild = childTasks.find((row) => !expectedIds.has(row.session_id));
    if (hiddenChild) {
      for (const repository of [taskRepo, messageRepo]) {
        expect(
          await repository.findPage({
            visibleToUserId: userId,
            sessionId: hiddenChild.session_id,
            limit: 1,
          })
        ).toEqual({ total: 0, data: [] });
        const mixed = await repository.findPage({
          visibleToUserId: userId,
          sessionIds: [hiddenChild.session_id, visibleChild.session_id],
          limit: 1,
        });
        expect(mixed.total).toBe(1);
        expect(mixed.data[0].session_id).toBe(visibleChild.session_id);
        expect(
          await repository.findPage({
            visibleToUserId: userId,
            sessionId: hiddenChild.session_id,
            taskId: visibleChild.task_id,
            limit: 1,
          })
        ).toEqual({ total: 0, data: [] });
      }
    }
    for (const repository of [taskRepo, messageRepo]) {
      expect(await repository.findAll({ visibleToUserId: userId, sessionIds: [] })).toEqual([]);
      expect(
        await repository.findPage({ visibleToUserId: userId, sessionIds: [], limit: 1 })
      ).toEqual({ total: 0, data: [] });
      expect(
        (await repository.findPage({ visibleToUserId: userId, skip: 100, limit: 1 })).data
      ).toEqual([]);
    }
    for (const boardId of [board.board_id, sharedBoard.board_id]) {
      const expected = new Set(
        paged.data.filter((row) => row.branch_board_id === boardId).map((row) => row.session_id)
      );
      expect(
        new Set(
          (await sessions.findByBoard(boardId, { visibleToUserId: userId })).map(
            (row) => row.session_id
          )
        )
      ).toEqual(expected);
    }
    // Exact IDs and intersecting scopes remain filters, not grants.
    const contradiction = await select(db, { id: branchTable.branch_id })
      .from(branchTable)
      .where(
        inVisibleBranchSet(db, userId, branchTable.branch_id, {
          branchId: groupedBranch,
          boardId: sharedBoard.board_id,
        })
      )
      .all();
    expect(contradiction).toEqual([]);
    expect(
      await select(db, { id: branchTable.branch_id })
        .from(branchTable)
        .where(inVisibleBranchSet(db, userId, branchTable.branch_id, { branchIds: [] }))
        .all()
    ).toEqual([]);
    const exactSet = await select(db, { id: branchTable.branch_id })
      .from(branchTable)
      .where(
        inVisibleBranchSet(db, userId, branchTable.branch_id, {
          branchId: groupedBranch,
          boardId: board.board_id,
          branchIds: [groupedBranch, hiddenBranch],
        })
      )
      .all();
    expect(exactSet).toEqual(rowIds.filter((row) => row.id === groupedBranch));
  }
  for (const userId of [owner, viewer, admin]) await verifyPrimitiveParity(userId);
  // Board visibility neither grants nor vetoes independent branch visibility.
  expect(await boards.findVisibleBoardIds(viewer)).not.toContain(board.board_id);
  expect(await boards.findVisibleBoardIds(viewer)).toContain(sharedBoard.board_id);
  const page = await sessions.findPage({ visibleToUserId: viewer, limit: 100 });
  expect(new Set(page.data.map((s) => s.session_id))).toEqual(visible);
  expect(page.total).toBe(16);
  expect((await sessions.findPage({ visibleToUserId: owner, limit: 100 })).total).toBe(all.size);
  // Admin bypass belongs to the trusted service hook, not to this user-id predicate.
  expect((await sessions.findPage({ visibleToUserId: admin, limit: 100 })).total).toBe(20);
  expect((await sessions.findPage({ limit: 100 })).total).toBe(all.size);
  expect(
    await sessions.findPage({ visibleToUserId: viewer, branchId: hiddenBranch, limit: 1 })
  ).toEqual({ total: 0, data: [] });
  expect(
    await sessions.findPage({ visibleToUserId: viewer, boardId: sharedBoard.board_id, limit: 1 })
  ).toEqual({ total: 0, data: [] });
  expect(await sessions.findPage({ visibleToUserId: viewer, branchIds: [], limit: 1 })).toEqual({
    total: 0,
    data: [],
  });
  const opts = {
    visibleToUserId: viewer,
    archived: false,
    status: 'idle' as const,
    sortCreatedAt: -1 as const,
  };
  const expected = (await sessions.findPage({ ...opts, limit: 100 })).data;
  expect(expected).toHaveLength(8);
  for (let skip = 0; skip <= expected.length; skip += 2) {
    const slice = await sessions.findPage({ ...opts, limit: 2, skip });
    expect(slice.total).toBe(8);
    expect(slice.data).toEqual(expected.slice(skip, skip + 2));
  }
  expect(await sessions.findPage({ ...opts, limit: 0 })).toEqual({ total: 8, data: [] });
  const scoped = await sessions.findPage({
    visibleToUserId: viewer,
    branchIds: [groupedBranch, shadowBranch],
    archived: true,
    limit: 100,
  });
  expect(scoped.total).toBe(1);
  expect(scoped.data[0]).toMatchObject({
    branch_id: groupedBranch,
    branch_board_id: board.board_id,
    sdk_home_scope: 'branch',
    custom_context: { inventory: true },
  });
  // Revocation/fallback is read anew; no process-local allowed-branch cache.
  await groups.update(group.group_id, { archived: true });
  await verifyPrimitiveParity(viewer);
  expect((await sessions.findPage({ visibleToUserId: viewer, limit: 100 })).total).toBe(16);
  expect(
    (await sessions.findPage({ visibleToUserId: viewer, branchId: groupedBranch, limit: 100 }))
      .total
  ).toBe(0);
  expect(
    (await sessions.findPage({ visibleToUserId: viewer, branchId: shadowBranch, limit: 100 })).total
  ).toBe(0);
  await groups.update(group.group_id, { archived: false });
  await groups.removeMember(group.group_id, viewer);
  await verifyPrimitiveParity(viewer);
  expect((await sessions.findPage({ visibleToUserId: viewer, limit: 100 })).total).toBe(16);
  return {
    owner,
    viewer,
    boardId: board.board_id,
    branchId: groupedBranch,
    sessionId: expected[0].session_id,
    total: all.size,
    childTaskId: childTasks[0].task_id,
    childMessageId: childMessages[0].message_id,
  };
}
