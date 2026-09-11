import {
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  RepoRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import {
  type BoardID,
  type BranchID,
  capabilityPolicyPresetCapabilities,
  type UserID,
  type UUID,
} from '@agor/core/types';
import { afterEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { BoardObjectsService } from './board-objects';
import { BoardsService } from './boards';
import { BranchesService } from './branches';

afterEach(() => vi.restoreAllMocks());

async function fixture(raw: Database) {
  const db = createTenantScopedDatabaseProxy(raw, { requireScope: false });
  const users = new UsersRepository(db);
  const owner = await users.create({ email: 'owner@move.test', role: 'member' });
  const oldViewer = await users.create({ email: 'old@move.test', role: 'member' });
  const newViewer = await users.create({ email: 'new@move.test', role: 'member' });
  const actor = await users.create({ email: 'actor@move.test', role: 'member' });
  const boards = new BoardRepository(db);
  const source = await boards.create({ name: 'Source', created_by: owner.user_id });
  const target = await boards.create({ name: 'Target', created_by: owner.user_id });
  const policies = new CapabilityPolicyRepository(db);
  for (const [board, viewer] of [
    [source, oldViewer],
    [target, newViewer],
  ] as const) {
    const policy = await policies.getBoardPolicies(board.board_id);
    policy.branch_template.access.sharing_mode = 'shared';
    policy.branch_template.access.others = { preset: 'none', capabilities: [], fs_access: 'none' };
    policy.branch_template.access.entries = [
      {
        entry_id: generateId(),
        principal: { principal_type: 'user', user_id: viewer.user_id as UserID },
        preset: 'collaborator',
        fs_access: 'read',
        capabilities: capabilityPolicyPresetCapabilities('branch_access', 'collaborator', 'read')!,
      },
    ];
    await policies.replaceBoardPolicies(board.board_id, policy, owner.user_id as UserID);
  }
  const repo = await new RepoRepository(db).create({
    name: 'Move',
    slug: 'move',
    repo_type: 'local',
    local_path: '/tmp/move-fixture',
    default_branch: 'main',
  });
  const branches = new BranchRepository(db);
  const branch = await branches.create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'Sparky',
    ref: 'main',
    path: '/tmp/move-fixture/sparky',
    branch_unique_id: 1,
    created_by: owner.user_id as UUID,
    board_id: source.board_id,
    permission_binding: 'inherit',
    custom_context: { teammate: { kind: 'teammate', displayName: 'Sparky' } },
  });
  await boards.setPrimaryTeammate(source.board_id, branch.branch_id);
  const objects = new BoardObjectRepository(db);
  const object = await objects.create({
    board_id: source.board_id,
    branch_id: branch.branch_id,
    position: { x: 10, y: 20 },
    zone_id: 'old-zone',
  });
  const app = feathers();
  app.set('config', {});
  const service = new BranchesService(db, app);
  const boardService = new BoardsService(db, {
    moveBranch: (id, boardId, params) => service.patch(id, { board_id: boardId }, params),
  });
  app.use('branches', service);
  app.use('boards', boardService, { methods: ['get', 'find', 'setPrimaryTeammate'] });
  app.use('board-objects', new BoardObjectsService(db));
  const boardEvents = vi.fn();
  const objectEvents = vi.fn();
  app.service('boards').on('patched', boardEvents);
  app.service('board-objects').on('created', objectEvents);
  app.service('board-objects').on('removed', objectEvents);
  const params = {
    user: { user_id: owner.user_id, email: owner.email, role: 'member' },
    provider: 'rest',
  };
  return {
    db,
    owner,
    actor,
    oldViewer,
    newViewer,
    boards,
    source,
    target,
    policies,
    branches,
    branch,
    objects,
    object,
    app,
    service,
    boardService,
    params,
    boardEvents,
    objectEvents,
  };
}

async function grantActor(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    source?: 'viewer' | 'editor';
    target?: 'viewer' | 'editor';
    branch?: 'viewer' | 'manager';
  }
) {
  for (const [board, preset] of [
    [f.source, options.source],
    [f.target, options.target],
  ] as const) {
    if (!preset) continue;
    const policy = await f.policies.getBoardPolicies(board.board_id);
    policy.board_access.sharing_mode = 'shared';
    policy.board_access.entries.push({
      entry_id: generateId(),
      principal: { principal_type: 'user', user_id: f.actor.user_id as UserID },
      preset,
      capabilities: capabilityPolicyPresetCapabilities('board_access', preset)!,
      fs_access: 'none',
    });
    if (board.board_id === f.source.board_id && options.branch) {
      policy.branch_template.access.entries.push({
        entry_id: generateId(),
        principal: { principal_type: 'user', user_id: f.actor.user_id as UserID },
        preset: options.branch,
        capabilities: capabilityPolicyPresetCapabilities('branch_access', options.branch)!,
        fs_access: 'none',
      });
    }
    await f.policies.replaceBoardPolicies(board.board_id, policy, f.owner.user_id as UserID);
  }
  return {
    provider: 'rest',
    user: { user_id: f.actor.user_id, email: f.actor.email, role: 'member' },
  };
}

async function expectUnchanged(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.branches.findById(f.branch.branch_id)).toEqual(f.branch);
  expect(await f.objects.findByBranchId(f.branch.branch_id)).toEqual(f.object);
  expect((await f.boards.findById(f.source.board_id))?.primary_teammate_id).toBe(
    f.branch.branch_id
  );
  expect((await f.boards.findById(f.target.board_id))?.primary_teammate_id).toBeUndefined();
  expect(f.boardEvents).not.toHaveBeenCalled();
  expect(f.objectEvents).not.toHaveBeenCalled();
}

for (const action of ['patch', 'update', 'assign'] as const) {
  dbTest(
    `authorized inherited ${action} adopts target access and clears old placement/primary`,
    async ({ db }) => {
      const f = await fixture(db);
      const beforeOwner = f.branch.primary_owner_user_id;
      const oldAccess = await f.policies.resolveBranchAccess(
        f.branch.branch_id,
        f.oldViewer.user_id as UserID
      );
      expect(oldAccess.fs_access).toBe('read');
      if (action === 'assign') {
        await f.boardService.setPrimaryTeammate(
          { boardId: f.target.board_id, branchId: f.branch.branch_id },
          f.params
        );
      } else {
        await f.app
          .service('branches')
          [action](f.branch.branch_id, { board_id: f.target.board_id }, f.params);
      }
      expect(await f.branches.findById(f.branch.branch_id)).toMatchObject({
        board_id: f.target.board_id,
        permission_binding: 'inherit',
        primary_owner_user_id: beforeOwner,
      });
      expect((await f.boards.findById(f.source.board_id))?.primary_teammate_id).toBeUndefined();
      expect((await f.boards.findById(f.target.board_id))?.primary_teammate_id).toBe(
        f.branch.branch_id
      );
      const placement = await f.objects.findByBranchId(f.branch.branch_id);
      expect(placement?.board_id).toBe(f.target.board_id);
      expect(placement?.zone_id).toBeUndefined();
      expect(
        await f.policies.resolveBranchAccess(f.branch.branch_id, f.oldViewer.user_id as UserID)
      ).toMatchObject({ capabilities: [], fs_access: 'none' });
      expect(
        (await f.policies.resolveBranchAccess(f.branch.branch_id, f.newViewer.user_id as UserID))
          .fs_access
      ).toBe('read');
      const viewers = await f.branches.findRealtimeViewUserIds(f.branch.branch_id);
      expect(viewers).not.toContain(f.oldViewer.user_id);
      expect(viewers).toContain(f.newViewer.user_id);
      expect(f.objectEvents).toHaveBeenCalledTimes(2);
      // Repeated Save does not recreate placement or duplicate primary ownership.
      await f.service.patch(f.branch.branch_id, { board_id: f.target.board_id }, f.params);
      expect(await f.objects.findByBranchId(f.branch.branch_id)).toEqual(placement);
      expect(f.objectEvents).toHaveBeenCalledTimes(2);
    }
  );
}

dbTest('explicit override and immutable owner survive a move', async ({ db }) => {
  const f = await fixture(db);
  const policy = await f.policies.getBranchPolicy(f.branch.branch_id);
  policy.binding_mode = 'override';
  policy.override_config = structuredClone(policy.inherited_config);
  await f.policies.replaceBranchPolicy(f.branch.branch_id, policy, f.owner.user_id as UserID);
  const before = await f.policies.getBranchPolicy(f.branch.branch_id);
  await f.service.patch(f.branch.branch_id, { board_id: f.target.board_id }, f.params);
  const after = await f.policies.getBranchPolicy(f.branch.branch_id);
  expect(after.binding_mode).toBe('override');
  expect(after.override_config).toEqual(before.override_config);
  expect(after.primary_owner_user_id).toBe(before.primary_owner_user_id);
  expect(
    (await f.policies.resolveBranchAccess(f.branch.branch_id, f.oldViewer.user_id as UserID))
      .fs_access
  ).toBe('read');
});

for (const denied of ['source', 'target', 'branch'] as const) {
  dbTest(`denies ${denied} view-only authority without mutation`, async ({ db }) => {
    const f = await fixture(db);
    const params = await grantActor(f, {
      source: denied === 'source' ? 'viewer' : 'editor',
      target: denied === 'target' ? 'viewer' : 'editor',
      branch: denied === 'branch' ? 'viewer' : 'manager',
    });
    await expect(
      f.service.patch(f.branch.branch_id, { board_id: f.target.board_id }, params)
    ).rejects.toThrow(/access is required/);
    await expectUnchanged(f);
  });
}

dbTest('non-owner Manager with Editor on both boards can move inherited data', async ({ db }) => {
  const f = await fixture(db);
  const params = await grantActor(f, { source: 'editor', target: 'editor', branch: 'manager' });
  await expect(
    f.service.patch(f.branch.branch_id, { board_id: f.target.board_id }, params)
  ).resolves.toMatchObject({ board_id: f.target.board_id, primary_owner_user_id: f.owner.user_id });
});

for (const failure of [
  'missing target',
  'no destination',
  'placement',
  'primary pointer',
] as const) {
  dbTest(`rolls back ${failure} failure, including queued realtime events`, async ({ db }) => {
    const f = await fixture(db);
    let target = f.target.board_id;
    if (failure === 'missing target') target = generateId() as BoardID;
    if (failure === 'placement')
      vi.spyOn(BoardObjectRepository.prototype, 'create').mockRejectedValueOnce(
        new Error('placement failed')
      );
    if (failure === 'primary pointer')
      vi.spyOn(BoardRepository.prototype, 'setPrimaryTeammateIfUnset').mockRejectedValueOnce(
        new Error('pointer failed')
      );
    await expect(
      f.service.patch(
        f.branch.branch_id,
        { board_id: failure === 'no destination' ? undefined : target, notes: 'must roll back' },
        f.params
      )
    ).rejects.toThrow();
    await expectUnchanged(f);
    if (failure === 'placement' || failure === 'primary pointer') {
      await expect(
        f.service.patch(f.branch.branch_id, { board_id: target }, f.params)
      ).resolves.toMatchObject({ board_id: target });
    }
  });
}

dbTest('assignment failure rolls back the common move and source primary', async ({ db }) => {
  const f = await fixture(db);
  vi.spyOn(BoardRepository.prototype, 'setPrimaryTeammate').mockRejectedValueOnce(
    new Error('assignment failed')
  );
  await expect(
    f.boardService.setPrimaryTeammate(
      { boardId: f.target.board_id, branchId: f.branch.branch_id },
      f.params
    )
  ).rejects.toThrow('assignment failed');
  await expectUnchanged(f);
});

dbTest(
  'moving does not replace an existing target primary; Assign refuses it atomically',
  async ({ db }) => {
    const f = await fixture(db);
    const other = await f.branches.create({
      ...f.branch,
      branch_id: generateId() as BranchID,
      board_id: f.target.board_id,
      name: 'Existing primary',
      branch_unique_id: 2,
      path: '/tmp/move-fixture/existing',
    });
    await f.boards.setPrimaryTeammate(f.target.board_id, other.branch_id);
    await expect(
      f.boardService.setPrimaryTeammate(
        { boardId: f.target.board_id, branchId: f.branch.branch_id },
        f.params
      )
    ).rejects.toThrow('already has a primary teammate');
    expect(await f.branches.findById(f.branch.branch_id)).toEqual(f.branch);
    expect(await f.objects.findByBranchId(f.branch.branch_id)).toEqual(f.object);
    await f.service.patch(f.branch.branch_id, { board_id: f.target.board_id }, f.params);
    expect((await f.boards.findById(f.target.board_id))?.primary_teammate_id).toBe(other.branch_id);
    expect((await f.boards.findById(f.source.board_id))?.primary_teammate_id).toBeUndefined();
  }
);
