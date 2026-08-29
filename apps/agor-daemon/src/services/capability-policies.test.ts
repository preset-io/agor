import {
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  type Database,
  generateId,
  RepoRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type {
  BoardCapabilityPolicies,
  BoardID,
  BranchCapabilityPolicy,
  BranchID,
  CapabilityPolicyEntry,
  UserID,
} from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { capabilityPolicyPresetCapabilities } from '../../../../packages/core/src/types/capability-policy';
import { setupCapabilityPolicyServices } from './capability-policies';

function params(userId: UserID, role = 'member') {
  return { provider: 'rest', route: { id: '' }, user: { user_id: userId, role } } as never;
}

function entry(
  kind: 'board_access' | 'branch_access',
  userId: UserID,
  preset: 'viewer' | 'collaborator' | 'manager',
  fsAccess: 'none' | 'read' | 'write' = 'none'
): CapabilityPolicyEntry {
  return {
    entry_id: generateId(),
    principal: { principal_type: 'user', user_id: userId },
    preset,
    capabilities: capabilityPolicyPresetCapabilities(kind, preset, fsAccess) ?? [],
    fs_access: kind === 'board_access' ? 'none' : fsAccess,
  };
}

async function fixture(db: Database) {
  const users = new UsersRepository(db);
  const owner = await users.create({ email: `${generateId()}-owner@example.com`, role: 'member' });
  const manager = await users.create({
    email: `${generateId()}-manager@example.com`,
    role: 'member',
  });
  const collaborator = await users.create({
    email: `${generateId()}-collaborator@example.com`,
    role: 'member',
  });
  const viewer = await users.create({
    email: `${generateId()}-viewer@example.com`,
    role: 'member',
  });
  const admin = await users.create({ email: `${generateId()}-admin@example.com`, role: 'admin' });
  const boards = new BoardRepository(db);
  const board = await boards.create({
    board_id: generateId(),
    name: 'Service policy board',
    created_by: owner.user_id,
    access_mode: 'private',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    name: 'Service policy repo',
    slug: `service-policy-${generateId()}`,
    repo_type: 'remote',
    remote_url: 'https://example.com/service-policy.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    board_id: board.board_id,
    name: 'service-policy-branch',
    ref: 'refs/heads/service-policy-branch',
    branch_unique_id: 45678,
    path: '/tmp/service-policy-branch',
    created_by: owner.user_id,
    permission_binding: 'override',
  });
  const policies = new CapabilityPolicyRepository(db);
  const boardPolicy = await policies.getBoardPolicies(board.board_id);
  boardPolicy.board_access.sharing_mode = 'shared';
  boardPolicy.board_access.entries = [
    entry('board_access', manager.user_id, 'manager'),
    entry('board_access', viewer.user_id, 'viewer'),
  ];
  boardPolicy.branch_template.access.sharing_mode = 'shared';
  boardPolicy.branch_template.access.entries = [
    entry('branch_access', manager.user_id, 'manager', 'write'),
  ];
  await policies.replaceBoardPolicies(board.board_id, boardPolicy, owner.user_id);
  const branchPolicy = await policies.getBranchPolicy(branch.branch_id);
  branchPolicy.override_config!.access.sharing_mode = 'shared';
  branchPolicy.override_config!.access.entries = [
    entry('branch_access', manager.user_id, 'manager', 'write'),
    entry('branch_access', collaborator.user_id, 'collaborator', 'read'),
  ];
  await policies.replaceBranchPolicy(branch.branch_id, branchPolicy, owner.user_id);
  await policies.setWorkspacePreferences({ session_sharing_enabled: true }, admin.user_id);
  return {
    owner: owner.user_id as UserID,
    manager: manager.user_id as UserID,
    collaborator: collaborator.user_id as UserID,
    viewer: viewer.user_id as UserID,
    admin: admin.user_id as UserID,
    boardId: board.board_id as BoardID,
    branchId: branch.branch_id as BranchID,
  };
}

describe('capability policy services', () => {
  dbTest('lets board managers manage the branch-template sharing switch', async ({ db }) => {
    const value = await fixture(db);
    const app = feathers();
    setupCapabilityPolicyServices(app, db as never);
    const service = app.service('boards/:id/permissions');
    const managerParams = { ...params(value.manager), route: { id: value.boardId } } as never;
    const current = (await service.find(managerParams)) as BoardCapabilityPolicies;
    const changed = structuredClone(current);
    changed.board_access.others = {
      preset: 'viewer',
      capabilities: ['board.view'],
      fs_access: 'none',
    };
    changed.branch_template.allow_shared_session_prompts = true;
    await expect(service.patch(null, changed, managerParams)).resolves.toMatchObject({
      board_access_revision: 3,
      branch_template: { allow_shared_session_prompts: true },
    });
  });

  dbTest('does not let board viewers change access or shared-session defaults', async ({ db }) => {
    const value = await fixture(db);
    const app = feathers();
    setupCapabilityPolicyServices(app, db as never);
    const service = app.service('boards/:id/permissions');
    const viewerParams = { ...params(value.viewer), route: { id: value.boardId } } as never;
    const current = (await service.find(viewerParams)) as BoardCapabilityPolicies;
    const sharing = structuredClone(current);
    sharing.branch_template.allow_shared_session_prompts = true;
    await expect(service.patch(null, sharing, viewerParams)).rejects.toMatchObject({ code: 403 });

    const accessEscalation = structuredClone(
      (await service.find(viewerParams)) as BoardCapabilityPolicies
    );
    accessEscalation.board_access.entries = [];
    await expect(service.patch(null, accessEscalation, viewerParams)).rejects.toMatchObject({
      code: 403,
    });
  });

  dbTest(
    'lets branch managers toggle sharing while collaborators remain read-only',
    async ({ db }) => {
      const value = await fixture(db);
      const app = feathers();
      setupCapabilityPolicyServices(app, db as never);
      const service = app.service('branches/:id/permissions');
      const collaboratorParams = {
        ...params(value.collaborator),
        route: { id: value.branchId },
      } as never;
      const current = (await service.find(collaboratorParams)) as BranchCapabilityPolicy;
      const ownSharing = structuredClone(current);
      ownSharing.override_config!.allow_shared_session_prompts = true;
      await expect(service.patch(null, ownSharing, collaboratorParams)).rejects.toMatchObject({
        code: 403,
      });

      const managerParams = { ...params(value.manager), route: { id: value.branchId } } as never;
      const managerEdit = structuredClone(
        (await service.find(managerParams)) as BranchCapabilityPolicy
      );
      managerEdit.override_config!.allow_shared_session_prompts = true;
      const collaboratorEntry = managerEdit.override_config!.access.entries.find(
        (candidate) =>
          candidate.principal.principal_type === 'user' &&
          candidate.principal.user_id === value.collaborator
      )!;
      collaboratorEntry.preset = 'viewer';
      collaboratorEntry.fs_access = 'none';
      collaboratorEntry.capabilities = ['branch.view'];
      await expect(service.patch(null, managerEdit, managerParams)).resolves.toMatchObject({
        override_config: {
          allow_shared_session_prompts: true,
          access: {
            entries: expect.arrayContaining([expect.objectContaining({ preset: 'viewer' })]),
          },
        },
      });
    }
  );

  dbTest('fails closed when the workspace sharing gate is off', async ({ db }) => {
    const value = await fixture(db);
    const app = feathers();
    setupCapabilityPolicyServices(app, db as never);
    await app
      .service('workspace-preferences')
      .patch(null, { session_sharing_enabled: false }, params(value.admin, 'admin'));

    const service = app.service('branches/:id/permissions');
    const managerParams = {
      ...params(value.manager),
      route: { id: value.branchId },
    } as never;
    const changed = structuredClone((await service.find(managerParams)) as BranchCapabilityPolicy);
    changed.override_config!.allow_shared_session_prompts = true;

    await expect(service.patch(null, changed, managerParams)).rejects.toMatchObject({
      code: 403,
    });
  });

  dbTest('reserves workspace sharing preference writes for admins', async ({ db }) => {
    const value = await fixture(db);
    const app = feathers();
    setupCapabilityPolicyServices(app, db as never);
    const service = app.service('workspace-preferences');

    await expect(
      service.patch(null, { session_sharing_enabled: false }, params(value.manager))
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      service.patch(null, { session_sharing_enabled: false }, params(value.admin, 'admin'))
    ).resolves.toEqual({ session_sharing_enabled: false });
  });

  dbTest('rejects stale global-admin claims after the tenant fence', async ({ db }) => {
    const value = await fixture(db);
    const app = feathers();
    setupCapabilityPolicyServices(app, db as never);
    const policyService = app.service('boards/:id/permissions');
    const staleAdminParams = {
      route: { id: value.boardId },
      user: { user_id: value.viewer, role: 'admin' },
    } as never;
    const policy = (await policyService.find(staleAdminParams)) as BoardCapabilityPolicies;
    policy.board_access.entries = [];

    await expect(policyService.patch(null, policy, staleAdminParams)).rejects.toMatchObject({
      code: 403,
    });
    await expect(
      app
        .service('workspace-preferences')
        .patch(null, { session_sharing_enabled: false }, staleAdminParams)
    ).rejects.toMatchObject({ code: 403 });
  });
});
