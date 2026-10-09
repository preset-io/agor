import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BoardID, BranchID, CapabilityPolicyEntry, SessionID, UserID } from '../../types';
import type { Database } from '../client';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { CapabilityPolicyRepository } from './capability-policies';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

/**
 * User-scope reads (design §3, commit 1.3): branch `created_by`, the teammate
 * marker read, per-board active branch counts, and id-list (`$in`) reads.
 * Every one is a filter composed with the existing visibility predicates —
 * never an access grant. Shared by the SQLite and PostgreSQL/RLS suites.
 */
export async function exerciseUserScopeReads(db: Database) {
  const users = new UsersRepository(db);
  const owner = (await users.create({ email: `${generateId()}@example.invalid`, role: 'member' }))
    .user_id as UserID;
  const viewer = (await users.create({ email: `${generateId()}@example.invalid`, role: 'member' }))
    .user_id as UserID;
  const boards = new BoardRepository(db);
  const sharedBoard = await boards.create({
    name: 'Shared',
    created_by: owner,
    access_mode: 'shared',
  });
  const privateBoard = await boards.create({
    name: 'Private',
    created_by: owner,
    access_mode: 'private',
  });
  const repo = await new RepoRepository(db).create({
    slug: `user-scope-${generateId()}`,
    name: 'User scope',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/user-scope.git',
    local_path: '/tmp/user-scope',
    default_branch: 'main',
  });
  const policies = new CapabilityPolicyRepository(db);
  const branchRepo = new BranchRepository(db);
  const sessionRepo = new SessionRepository(db);
  const viewerEntry = (): CapabilityPolicyEntry => ({
    entry_id: generateId(),
    principal: { principal_type: 'user', user_id: viewer },
    preset: 'viewer',
    capabilities: ['branch.view'],
    fs_access: 'none',
  });

  const specs = [
    { key: 'public', board: sharedBoard.board_id, shared: true, teammate: false, archived: false },
    {
      key: 'private',
      board: sharedBoard.board_id,
      shared: false,
      teammate: false,
      archived: false,
    },
    { key: 'mate', board: sharedBoard.board_id, shared: true, teammate: true, archived: false },
    {
      key: 'privateMate',
      board: sharedBoard.board_id,
      shared: false,
      teammate: true,
      archived: false,
    },
    { key: 'archived', board: sharedBoard.board_id, shared: true, teammate: false, archived: true },
    // A branch shared with the viewer on a board the viewer cannot see.
    {
      key: 'hiddenBoard',
      board: privateBoard.board_id,
      shared: true,
      teammate: false,
      archived: false,
    },
  ] as const;
  const ids = {} as Record<(typeof specs)[number]['key'], BranchID>;
  for (const [i, spec] of specs.entries()) {
    const branch = await branchRepo.create({
      repo_id: repo.repo_id,
      board_id: spec.board,
      created_by: owner,
      name: spec.key,
      ref: spec.key,
      path: `/tmp/user-scope/${spec.key}`,
      branch_unique_id: 7000 + i,
      permission_binding: 'override',
      archived: spec.archived,
      ...(spec.teammate
        ? { custom_context: { teammate: { kind: 'teammate', displayName: spec.key } } }
        : {}),
    });
    ids[spec.key] = branch.branch_id;
    const policy = await policies.getBranchPolicy(branch.branch_id);
    const config = policy.override_config ?? policy.inherited_config!;
    config.access.sharing_mode = spec.shared ? 'shared' : 'private';
    config.access.others = { preset: 'none', capabilities: [], fs_access: 'none' };
    config.access.entries = spec.shared ? [viewerEntry()] : [];
    await policies.replaceBranchPolicy(
      branch.branch_id,
      { ...policy, override_config: config },
      owner
    );
  }
  const boardPolicy = await policies.getBoardPolicies(sharedBoard.board_id);
  await policies.replaceBoardPolicies(
    sharedBoard.board_id,
    {
      ...boardPolicy,
      board_access: {
        ...boardPolicy.board_access,
        sharing_mode: 'shared',
        entries: [
          {
            entry_id: generateId(),
            principal: { principal_type: 'user', user_id: viewer },
            preset: 'viewer',
            capabilities: ['board.view'],
            fs_access: 'none',
          },
        ],
      },
    },
    owner
  );

  // ── Branch created_by: a filter over the visible set. ────────────────────
  const byOwner = await branchRepo.findPage({
    visibleToUserId: viewer,
    createdBy: owner,
    archived: false,
  });
  expect(new Set(byOwner.data.map((b) => b.branch_id))).toEqual(
    new Set([ids.public, ids.mate, ids.hiddenBoard])
  );
  expect((await branchRepo.findPage({ visibleToUserId: viewer, createdBy: viewer })).data).toEqual(
    []
  );
  expect(
    new Set(
      (
        await branchRepo.findPage({ visibleToUserId: owner, createdBy: owner, archived: false })
      ).data.map((b) => b.branch_id)
    )
  ).toEqual(new Set([ids.public, ids.private, ids.mate, ids.privateMate, ids.hiddenBoard]));

  // ── branch_id $in: hidden ids are dropped, never granted. ───────────────
  expect(
    (
      await branchRepo.findPage({
        visibleToUserId: viewer,
        branchIds: [ids.public, ids.private, ids.privateMate],
      })
    ).data.map((b) => b.branch_id)
  ).toEqual([ids.public]);

  // ── Teammates: only teammate branches the caller can view, with the real total. ──
  const mates = (visibleToUserId: UserID) =>
    branchRepo.findPage({ visibleToUserId, archived: false, teammate: true, limit: 1000 });
  const viewerMates = await mates(viewer);
  expect(viewerMates.data.map((b) => b.branch_id)).toEqual([ids.mate]);
  expect(viewerMates.total).toBe(1);
  const ownerMates = await mates(owner);
  expect(new Set(ownerMates.data.map((b) => b.branch_id))).toEqual(
    new Set([ids.mate, ids.privateMate])
  );
  expect(ownerMates.total).toBe(2);

  // ── Per-board counts: active, visible branches on visible boards. ───────
  const countsFor = async (visibleToUserId?: UserID) =>
    new Map(
      (await branchRepo.countActiveByBoard({ visibleToUserId })).map((row) => [
        row.board_id,
        row.branch_count,
      ])
    );
  const viewerCounts = await countsFor(viewer);
  expect(viewerCounts.get(sharedBoard.board_id as BoardID)).toBe(2); // public + mate
  expect(viewerCounts.has(privateBoard.board_id as BoardID)).toBe(false);
  const ownerCounts = await countsFor(owner);
  expect(ownerCounts.get(sharedBoard.board_id as BoardID)).toBe(4);
  expect(ownerCounts.get(privateBoard.board_id as BoardID)).toBe(1);
  expect((await countsFor()).get(sharedBoard.board_id as BoardID)).toBe(4);

  // ── session_id $in: intersects with branch visibility. ──────────────────
  const visibleSession = await sessionRepo.create({
    branch_id: ids.public,
    created_by: owner,
    status: 'idle',
  });
  const hiddenSession = await sessionRepo.create({
    branch_id: ids.private,
    created_by: owner,
    status: 'idle',
  });
  const sessionIds = [visibleSession.session_id, hiddenSession.session_id] as SessionID[];
  expect(
    (await sessionRepo.findPage({ visibleToUserId: viewer, sessionIds, limit: 10 })).data.map(
      (s) => s.session_id
    )
  ).toEqual([visibleSession.session_id]);
  expect(
    (await sessionRepo.findPage({ visibleToUserId: owner, sessionIds, limit: 10 })).total
  ).toBe(2);
  expect(await sessionRepo.findPage({ visibleToUserId: owner, sessionIds: [], limit: 10 })).toEqual(
    { data: [], total: 0 }
  );

  // ── Session counts: active sessions on visible branches, per branch or board. ──
  const sessionCounts = async (groupBy: 'branch_id' | 'board_id', visibleToUserId?: UserID) =>
    new Map(
      (await sessionRepo.countActive({ groupBy, visibleToUserId })).map((row) => [
        row.id,
        row.session_count,
      ])
    );
  expect(await sessionCounts('branch_id', viewer)).toEqual(new Map([[ids.public, 1]]));
  expect(await sessionCounts('branch_id', owner)).toEqual(
    new Map([
      [ids.public, 1],
      [ids.private, 1],
    ])
  );
  expect(await sessionCounts('board_id', viewer)).toEqual(new Map([[sharedBoard.board_id, 1]]));
  expect(await sessionCounts('board_id')).toEqual(new Map([[sharedBoard.board_id, 2]]));

  // ── search: every token in a searchable field, over the visible set. ────
  const branchSearch = async (search: string, visibleToUserId: UserID) =>
    new Set(
      (await branchRepo.findPage({ visibleToUserId, search, archived: false })).data.map(
        (b) => b.branch_id
      )
    );
  expect(await branchSearch('MATE', viewer)).toEqual(new Set([ids.mate]));
  expect(await branchSearch('mate', owner)).toEqual(new Set([ids.mate, ids.privateMate]));
  expect(await branchSearch('priv mate', owner)).toEqual(new Set([ids.privateMate]));
  expect(await branchSearch('%', owner)).toEqual(new Set());
  // The branch's repo (slug, name), path, id and unique id, as Settings searched them.
  const active = { owner: [ids.public, ids.private, ids.mate, ids.privateMate, ids.hiddenBoard] };
  expect(await branchSearch(repo.slug, owner)).toEqual(new Set(active.owner));
  expect(await branchSearch('user SCOPE', viewer)).toEqual(
    new Set([ids.public, ids.mate, ids.hiddenBoard])
  );
  expect(await branchSearch('user-scope/privateMate', owner)).toEqual(new Set([ids.privateMate]));
  expect(await branchSearch('user-scope/private', viewer)).toEqual(new Set());
  expect(await branchSearch(ids.public, owner)).toEqual(new Set([ids.public]));
  expect(await branchSearch('7000 public', owner)).toEqual(new Set([ids.public]));
  const titled = await sessionRepo.create({
    branch_id: ids.public,
    created_by: owner,
    status: 'idle',
    title: 'Fix the LOGIN flow',
    description: '100% done',
  });
  const hiddenTitled = await sessionRepo.create({
    branch_id: ids.private,
    created_by: owner,
    status: 'idle',
    title: 'Fix the login page',
  });
  const sessionSearch = async (search: string, visibleToUserId: UserID) =>
    (await sessionRepo.findPage({ visibleToUserId, search, limit: 10 })).data.map(
      (s) => s.session_id
    );
  expect(await sessionSearch('login fix', viewer)).toEqual([titled.session_id]);
  expect((await sessionSearch('login fix', owner)).length).toBe(2);
  expect(await sessionSearch('100%', viewer)).toEqual([titled.session_id]);
  expect(await sessionSearch('_', viewer)).toEqual([]);
  expect(await sessionSearch('   ', owner)).toEqual([]);

  return {
    owner,
    viewer,
    boardIds: [sharedBoard.board_id, privateBoard.board_id] as BoardID[],
    branchIds: Object.values(ids),
    sessionIds,
    titledSessionIds: [titled.session_id, hiddenTitled.session_id] as SessionID[],
  };
}
