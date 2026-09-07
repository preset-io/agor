import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID, CapabilityPolicyEntry, UserID } from '../../types';
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
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
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
  };
}
