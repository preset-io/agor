import type {
  BoardID,
  BranchID,
  CapabilityPolicyEntry,
  CapabilityPolicyFsAccess,
  CapabilityPolicyPresetId,
  GroupID,
  UserID,
} from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { capabilityPolicyPresetCapabilities } from '../../types/capability-policy';
import type { Database } from '../client';
import { update } from '../database-wrapper';
import { branchPermissionConfigs } from '../schema';
import { dbTest } from '../test-helpers';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { CapabilityPolicyRepository } from './capability-policies';
import { GroupRepository } from './groups';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

function userEntry(
  userId: UserID,
  preset: CapabilityPolicyPresetId,
  fsAccess: CapabilityPolicyFsAccess = 'none'
): CapabilityPolicyEntry {
  const kind = preset === 'editor' ? 'board_access' : 'branch_access';
  return {
    entry_id: generateId(),
    principal: { principal_type: 'user', user_id: userId },
    preset,
    capabilities: capabilityPolicyPresetCapabilities(kind, preset, fsAccess) ?? [],
    fs_access: fsAccess,
  };
}

function boardUserEntry(userId: UserID, preset: 'none' | 'viewer' | 'editor' | 'manager') {
  return {
    entry_id: generateId(),
    principal: { principal_type: 'user' as const, user_id: userId },
    preset,
    capabilities: capabilityPolicyPresetCapabilities('board_access', preset) ?? [],
    fs_access: 'none' as const,
  };
}

function boardGroupEntry(groupId: GroupID, preset: 'none' | 'viewer' | 'editor' | 'manager') {
  return {
    entry_id: generateId(),
    principal: { principal_type: 'group' as const, group_id: groupId },
    preset,
    capabilities: capabilityPolicyPresetCapabilities('board_access', preset) ?? [],
    fs_access: 'none' as const,
  };
}

function groupEntry(
  groupId: GroupID,
  preset: 'none' | 'viewer' | 'collaborator' | 'manager',
  fsAccess: CapabilityPolicyFsAccess
): CapabilityPolicyEntry {
  return {
    entry_id: generateId(),
    principal: { principal_type: 'group', group_id: groupId },
    preset,
    capabilities: capabilityPolicyPresetCapabilities('branch_access', preset, fsAccess) ?? [],
    fs_access: fsAccess,
  };
}

async function fixture(db: Database) {
  const users = new UsersRepository(db);
  const owner = await users.create({ email: `${generateId()}-owner@example.com`, role: 'member' });
  const direct = await users.create({
    email: `${generateId()}-direct@example.com`,
    role: 'member',
  });
  const grouped = await users.create({
    email: `${generateId()}-grouped@example.com`,
    role: 'member',
  });
  const unmatched = await users.create({
    email: `${generateId()}-unmatched@example.com`,
    role: 'member',
  });
  const viewer = await users.create({
    email: `${generateId()}-viewer@example.com`,
    role: 'member',
  });
  const groups = new GroupRepository(db);
  const readers = await groups.create({
    name: `Readers ${generateId()}`,
    created_by: owner.user_id,
  });
  const writers = await groups.create({
    name: `Writers ${generateId()}`,
    created_by: owner.user_id,
  });
  await groups.addMember(readers.group_id, direct.user_id, owner.user_id);
  await groups.addMember(readers.group_id, grouped.user_id, owner.user_id);
  await groups.addMember(writers.group_id, grouped.user_id, owner.user_id);

  const repos = new RepoRepository(db);
  const repo = await repos.create({
    repo_id: generateId(),
    slug: `capability-${generateId()}`,
    name: 'Capability test',
    repo_type: 'remote',
    remote_url: 'https://example.com/capability.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const boards = new BoardRepository(db);
  const board = await boards.create({
    board_id: generateId(),
    name: 'Capability board',
    created_by: owner.user_id,
    access_mode: 'private',
  });
  const branches = new BranchRepository(db);
  const branch = await branches.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    board_id: board.board_id,
    created_by: owner.user_id,
    name: 'capability-branch',
    ref: 'refs/heads/capability-branch',
    branch_unique_id: 98765,
    path: '/tmp/capability-branch',
    permission_binding: 'override',
  });
  return {
    owner: owner.user_id as UserID,
    direct: direct.user_id as UserID,
    grouped: grouped.user_id as UserID,
    unmatched: unmatched.user_id as UserID,
    viewer: viewer.user_id as UserID,
    readers: readers.group_id as GroupID,
    writers: writers.group_id as GroupID,
    boardId: board.board_id as BoardID,
    branchId: branch.branch_id as BranchID,
  };
}

describe('CapabilityPolicyRepository', () => {
  dbTest('creates resources and their required normalized policies atomically', async ({ db }) => {
    const value = await fixture(db);
    const policies = new CapabilityPolicyRepository(db);

    await expect(policies.getBoardPolicies(value.boardId)).resolves.toMatchObject({
      primary_owner_user_id: value.owner,
      board_access_revision: 1,
      branch_template_revision: 1,
      board_access: { sharing_mode: 'private', entries: [] },
    });
    await expect(policies.getBranchPolicy(value.branchId)).resolves.toMatchObject({
      primary_owner_user_id: value.owner,
      binding_mode: 'override',
      revision: 1,
      override_config: { access: { sharing_mode: 'private', entries: [] } },
    });
  });

  dbTest(
    'uses direct-user shadowing, additive groups, then Others for unmatched members',
    async ({ db }) => {
      const value = await fixture(db);
      const policies = new CapabilityPolicyRepository(db);
      const current = await policies.getBranchPolicy(value.branchId);
      const config = structuredClone(current.override_config!);
      config.access.sharing_mode = 'shared';
      config.access.entries = [
        userEntry(value.direct, 'viewer'),
        groupEntry(value.readers, 'collaborator', 'read'),
        groupEntry(value.writers, 'manager', 'write'),
      ];
      config.access.others = {
        preset: 'collaborator',
        capabilities:
          capabilityPolicyPresetCapabilities('branch_access', 'collaborator', 'read') ?? [],
        fs_access: 'read',
      };
      await policies.replaceBranchPolicy(
        value.branchId,
        { ...current, override_config: config },
        value.owner
      );

      expect(await policies.resolveBranchAccess(value.branchId, value.direct)).toMatchObject({
        source: 'direct_user',
        fs_access: 'none',
        capabilities: ['branch.view'],
      });
      expect(await policies.resolveBranchAccess(value.branchId, value.grouped)).toMatchObject({
        source: 'group',
        fs_access: 'write',
        group_ids: expect.arrayContaining([value.readers, value.writers]),
      });
      expect(await policies.resolveBranchAccess(value.branchId, value.unmatched)).toMatchObject({
        source: 'others',
        fs_access: 'read',
      });
      expect(
        (await policies.resolveBranchAccess(value.branchId, value.grouped)).capabilities
      ).toContain('branch.policy.manage');
    }
  );

  dbTest('denies permissive Others access to a nonexistent principal', async ({ db }) => {
    const value = await fixture(db);
    const policies = new CapabilityPolicyRepository(db);
    const boardPolicy = await policies.getBoardPolicies(value.boardId);
    boardPolicy.board_access.sharing_mode = 'shared';
    boardPolicy.board_access.others = {
      preset: 'viewer',
      capabilities: capabilityPolicyPresetCapabilities('board_access', 'viewer') ?? [],
      fs_access: 'none',
    };
    boardPolicy.branch_template.access.sharing_mode = 'shared';
    boardPolicy.branch_template.access.others = {
      preset: 'collaborator',
      capabilities:
        capabilityPolicyPresetCapabilities('branch_access', 'collaborator', 'write') ?? [],
      fs_access: 'write',
    };
    await policies.replaceBoardPolicies(value.boardId, boardPolicy, value.owner);
    const branchPolicy = await policies.getBranchPolicy(value.branchId);
    branchPolicy.override_config!.access = structuredClone(boardPolicy.branch_template.access);
    await policies.replaceBranchPolicy(value.branchId, branchPolicy, value.owner);

    const missing = generateId() as UserID;
    await expect(policies.resolveBoardAccess(value.boardId, missing)).resolves.toMatchObject({
      capabilities: [],
      fs_access: 'none',
      is_primary_owner: false,
    });
    await expect(policies.resolveBranchAccess(value.branchId, missing)).resolves.toMatchObject({
      capabilities: [],
      fs_access: 'none',
      is_primary_owner: false,
    });
  });

  dbTest(
    'materializes board realtime viewers with direct/group/Others precedence',
    async ({ db }) => {
      const value = await fixture(db);
      const policies = new CapabilityPolicyRepository(db);
      const boards = new BoardRepository(db);
      const current = await policies.getBoardPolicies(value.boardId);
      current.board_access.sharing_mode = 'shared';
      current.board_access.entries = [
        boardUserEntry(value.direct, 'none'),
        boardGroupEntry(value.readers, 'viewer'),
      ];
      current.board_access.others = {
        preset: 'viewer',
        capabilities: capabilityPolicyPresetCapabilities('board_access', 'viewer') ?? [],
        fs_access: 'none',
      };
      await policies.replaceBoardPolicies(value.boardId, current, value.owner);

      const viewers = await boards.findRealtimeViewUserIds(value.boardId);
      expect(viewers).toEqual(
        expect.arrayContaining([value.owner, value.grouped, value.unmatched, value.viewer])
      );
      expect(viewers).not.toContain(value.direct);
    }
  );

  dbTest(
    'materializes realtime viewers with the same direct/group/Others precedence',
    async ({ db }) => {
      const value = await fixture(db);
      const policies = new CapabilityPolicyRepository(db);
      const branches = new BranchRepository(db);
      const current = await policies.getBranchPolicy(value.branchId);
      const config = structuredClone(current.override_config!);
      config.access.sharing_mode = 'shared';
      config.access.entries = [
        // This explicit deny shadows the Readers group and permissive Others.
        userEntry(value.direct, 'none'),
        groupEntry(value.readers, 'collaborator', 'read'),
      ];
      config.access.others = {
        preset: 'viewer',
        capabilities: capabilityPolicyPresetCapabilities('branch_access', 'viewer') ?? [],
        fs_access: 'none',
      };
      await policies.replaceBranchPolicy(
        value.branchId,
        { ...current, override_config: config },
        value.owner
      );

      const viewers = await branches.findRealtimeViewUserIds(value.branchId);
      expect(viewers).toEqual(
        expect.arrayContaining([value.owner, value.grouped, value.unmatched, value.viewer])
      );
      expect(viewers).not.toContain(value.direct);
    }
  );

  dbTest(
    'keeps Private a hard SQL gate even if named rows survive outside the API',
    async ({ db }) => {
      const value = await fixture(db);
      const policies = new CapabilityPolicyRepository(db);
      const branches = new BranchRepository(db);
      const current = await policies.getBranchPolicy(value.branchId);
      const config = structuredClone(current.override_config!);
      config.access.sharing_mode = 'shared';
      config.access.entries = [userEntry(value.direct, 'viewer')];
      const saved = await policies.replaceBranchPolicy(
        value.branchId,
        { ...current, override_config: config },
        value.owner
      );

      // Normal writes clear entries when switching to Private. This simulates a
      // damaged/manual row so the inventory predicate itself still fails closed.
      await update(db, branchPermissionConfigs)
        .set({ sharing_mode: 'private' })
        .where(eq(branchPermissionConfigs.branch_id, value.branchId))
        .run();

      expect(saved.override_config?.access.entries).toHaveLength(1);
      await expect(
        policies.resolveBranchAccess(value.branchId, value.direct)
      ).resolves.toMatchObject({ capabilities: [] });
      await expect(
        branches.findAccessibleById(value.branchId, value.direct, { minimumPermission: 'view' })
      ).resolves.toBeNull();
      await expect(branches.findRealtimeViewUserIds(value.branchId)).resolves.not.toContain(
        value.direct
      );
    }
  );

  dbTest('treats branch inheritance as the entire board template package', async ({ db }) => {
    const value = await fixture(db);
    const policies = new CapabilityPolicyRepository(db);
    const board = await policies.getBoardPolicies(value.boardId);
    board.branch_template.access.sharing_mode = 'shared';
    board.branch_template.access.entries = [groupEntry(value.readers, 'collaborator', 'read')];
    board.branch_template.allow_shared_session_prompts = true;
    await policies.replaceBoardPolicies(value.boardId, board, value.owner);
    const branch = await policies.getBranchPolicy(value.branchId);
    await policies.replaceBranchPolicy(
      value.branchId,
      {
        primary_owner_user_id: value.owner,
        revision: branch.revision,
        binding_mode: 'inherit',
        inherited_from_board_id: value.boardId,
        inherited_config: board.branch_template,
      },
      value.owner
    );

    await expect(policies.getBranchPolicy(value.branchId)).resolves.toMatchObject({
      binding_mode: 'inherit',
      inherited_from_board_id: value.boardId,
      inherited_config: {
        access: { entries: [expect.objectContaining({ preset: 'collaborator' })] },
        allow_shared_session_prompts: true,
      },
    });
    expect(await policies.resolveBranchAccess(value.branchId, value.direct)).toMatchObject({
      source: 'group',
      fs_access: 'read',
    });
  });

  dbTest('materializes inherited packages before a board is hard-deleted', async ({ db }) => {
    const value = await fixture(db);
    const policies = new CapabilityPolicyRepository(db);
    const boards = new BoardRepository(db);
    const branches = new BranchRepository(db);
    const inherited = await branches.create({
      branch_id: generateId(),
      repo_id: (await branches.findById(value.branchId))!.repo_id,
      board_id: value.boardId,
      created_by: value.owner,
      name: 'survives-board-delete',
      ref: 'refs/heads/survives-board-delete',
      branch_unique_id: 98766,
      path: '/tmp/survives-board-delete',
      permission_binding: 'inherit',
    });
    const boardPolicy = await policies.getBoardPolicies(value.boardId);
    boardPolicy.branch_template.access.sharing_mode = 'shared';
    boardPolicy.branch_template.access.entries = [
      groupEntry(value.readers, 'collaborator', 'read'),
    ];
    boardPolicy.branch_template.allow_shared_session_prompts = true;
    await policies.replaceBoardPolicies(value.boardId, boardPolicy, value.owner);

    await boards.delete(value.boardId);

    const survivingBranch = await branches.findById(inherited.branch_id);
    expect(survivingBranch).toMatchObject({
      board_id: undefined,
      permission_binding: 'override',
    });
    await expect(policies.getBranchPolicy(inherited.branch_id)).resolves.toMatchObject({
      binding_mode: 'override',
      override_config: {
        access: {
          entries: [expect.objectContaining({ preset: 'collaborator', fs_access: 'read' })],
        },
        allow_shared_session_prompts: true,
      },
    });
  });

  dbTest(
    'requires workspace and branch opt-ins for foreign branch-home prompting',
    async ({ db }) => {
      const value = await fixture(db);
      const policies = new CapabilityPolicyRepository(db);
      const current = await policies.getBranchPolicy(value.branchId);
      const config = structuredClone(current.override_config!);
      config.access.sharing_mode = 'shared';
      config.access.entries = [
        userEntry(value.direct, 'collaborator', 'read'),
        userEntry(value.viewer, 'viewer'),
      ];
      config.allow_shared_session_prompts = true;
      await policies.replaceBranchPolicy(
        value.branchId,
        { ...current, override_config: config },
        value.owner
      );

      await expect(
        policies.resolveSessionPromptAuthority({
          branch_id: value.branchId,
          caller_user_id: value.direct,
          session_owner_user_id: value.owner,
          session_sdk_home_scope: 'execution_home',
        })
      ).resolves.toEqual({
        allowed: false,
        source: 'denied',
        denial_reason: 'execution_home_sharing_disabled',
      });

      await expect(
        policies.resolveSessionPromptAuthority({
          branch_id: value.branchId,
          caller_user_id: value.direct,
          session_owner_user_id: value.owner,
          session_sdk_home_scope: 'branch',
        })
      ).resolves.toEqual({
        allowed: false,
        source: 'denied',
        denial_reason: 'workspace_session_sharing_disabled',
      });

      await policies.setWorkspacePreferences({ session_sharing_enabled: true }, value.owner);
      await expect(
        policies.resolveSessionPromptAuthority({
          branch_id: value.branchId,
          caller_user_id: value.direct,
          session_owner_user_id: value.owner,
          session_sdk_home_scope: 'branch',
        })
      ).resolves.toEqual({
        allowed: true,
        execution_user_id: value.direct,
        source: 'branch_session',
      });
      await expect(
        policies.resolveSessionPromptAuthority({
          branch_id: value.branchId,
          caller_user_id: value.viewer,
          session_owner_user_id: value.owner,
          session_sdk_home_scope: 'branch',
        })
      ).resolves.toEqual({
        allowed: false,
        source: 'denied',
        denial_reason: 'branch_access_required',
      });

      await policies.setWorkspacePreferences({ session_sharing_enabled: false }, value.owner);
      await expect(policies.getBranchPolicy(value.branchId)).resolves.toMatchObject({
        override_config: { allow_shared_session_prompts: false },
      });
    }
  );

  dbTest('enforces immutable ownership and optimistic revisions', async ({ db }) => {
    const value = await fixture(db);
    const policies = new CapabilityPolicyRepository(db);
    const current = await policies.getBoardPolicies(value.boardId);
    const changed = structuredClone(current);
    changed.board_access.sharing_mode = 'shared';
    changed.board_access.entries = [boardUserEntry(value.direct, 'viewer')];
    const saved = await policies.replaceBoardPolicies(value.boardId, changed, value.owner);
    expect(saved.board_access_revision).toBe(2);

    await expect(
      policies.replaceBoardPolicies(value.boardId, changed, value.owner)
    ).rejects.toThrow('reload before saving');
    await expect(
      policies.replaceBoardPolicies(
        value.boardId,
        { ...saved, primary_owner_user_id: value.direct },
        value.owner
      )
    ).rejects.toThrow('Primary ownership is immutable');
  });

  dbTest(
    'lists boards only from board policy, never from child-branch visibility',
    async ({ db }) => {
      const value = await fixture(db);
      const policies = new CapabilityPolicyRepository(db);
      const branches = new BranchRepository(db);
      const board = await policies.getBoardPolicies(value.boardId);
      expect(board.board_access.sharing_mode).toBe('private');
      const branch = await policies.getBranchPolicy(value.branchId);
      const config = structuredClone(branch.override_config!);
      config.access.sharing_mode = 'shared';
      config.access.others = {
        preset: 'viewer',
        capabilities: capabilityPolicyPresetCapabilities('branch_access', 'viewer') ?? [],
        fs_access: 'none',
      };
      await policies.replaceBranchPolicy(
        value.branchId,
        { ...branch, override_config: config },
        value.owner
      );

      await expect(
        branches.findAccessibleById(value.branchId, value.unmatched, { minimumPermission: 'view' })
      ).resolves.toMatchObject({ branch_id: value.branchId });
      await expect(
        new BoardRepository(db).findAll({ visibleToUserId: value.unmatched })
      ).resolves.toEqual([]);
    }
  );

  dbTest(
    'expands explicit filesystem users and indexes group changes across inherited branches',
    async ({ db }) => {
      const value = await fixture(db);
      const policies = new CapabilityPolicyRepository(db);
      const branches = new BranchRepository(db);
      const board = await policies.getBoardPolicies(value.boardId);
      board.branch_template.access.sharing_mode = 'shared';
      board.branch_template.access.entries = [groupEntry(value.writers, 'collaborator', 'write')];
      await policies.replaceBoardPolicies(value.boardId, board, value.owner);
      const branch = await policies.getBranchPolicy(value.branchId);
      await policies.replaceBranchPolicy(
        value.branchId,
        {
          primary_owner_user_id: value.owner,
          revision: branch.revision,
          binding_mode: 'inherit',
          inherited_from_board_id: value.boardId,
          inherited_config: board.branch_template,
        },
        value.owner
      );

      await expect(branches.findExplicitFsAccessUserIds(value.branchId)).resolves.toEqual(
        expect.arrayContaining([value.owner, value.grouped])
      );
      await expect(
        branches.findExplicitFsAccessBranchIdsForGroup(value.writers)
      ).resolves.toContain(value.branchId);

      const inherited = await policies.getBranchPolicy(value.branchId);
      await policies.replaceBranchPolicy(
        value.branchId,
        {
          ...inherited,
          binding_mode: 'override',
          override_config: structuredClone(inherited.inherited_config!),
        },
        value.owner
      );
      await expect(
        branches.findExplicitFsAccessBranchIdsForGroup(value.writers)
      ).resolves.toContain(value.branchId);

      const overridden = await policies.getBranchPolicy(value.branchId);
      const overrideConfig = structuredClone(overridden.override_config!);
      overrideConfig.access.entries = [];
      await policies.replaceBranchPolicy(
        value.branchId,
        { ...overridden, override_config: overrideConfig },
        value.owner
      );
      await expect(
        branches.findExplicitFsAccessBranchIdsForGroup(value.writers)
      ).resolves.not.toContain(value.branchId);
    }
  );
});
