import {
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  GroupRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UserPrimaryTeammateRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, EffectiveBranchAccess, Params, TenantID } from '@agor/core/types';
import { capabilityPolicyPresetCapabilities } from '@agor/core/types';
import { beforeEach, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import {
  setTestBranchUserRole,
  ownedDbTest as test,
} from '../../../../packages/core/src/db/test-helpers';
import { markBranchArchiveDeleteAuthorized } from '../utils/branch-archive-delete-authorization';
import { requestExecutor, spawnExecutor } from '../utils/spawn-executor';
import { BranchesService } from './branches';
import { setupBranchEffectiveAccessService } from './groups';

vi.mock('../utils/spawn-executor', () => ({
  requestExecutor: vi.fn(),
  spawnExecutor: vi.fn(),
  getDaemonUrl: () => 'http://127.0.0.1:3030',
}));
const tenant = { tenant_id: 'default' as TenantID, source: 'explicit' as const };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestExecutor).mockResolvedValue({ success: true, data: { exists: true } });
});
function setup(db: ConstructorParameters<typeof BranchesService>[0], allowSuperadmin = false) {
  const archiveBranchSessions = vi.fn().mockResolvedValue({ count: 0 });
  const emit = vi.fn();
  const app = {
    get: () => ({ execution: { allow_superadmin: allowSuperadmin } }),
    emit: vi.fn(),
    sessionTokenService: { generateCommandToken: vi.fn().mockResolvedValue('fixture-token') },
    service: () => ({ emit, archiveBranchSessions }),
  } as unknown as Application;
  const service = new BranchesService(db, app);
  vi.spyOn(service as never, 'resolveEnvironmentExecutorContext').mockResolvedValue({
    env: {},
    executionUserId: 'fixture',
    branchFsAccess: 'write',
    sandboxMounts: {},
  } as never);
  return { service, emit, archiveBranchSessions };
}

test('clean rejects policy, protection, public overrides, and busy activity before dispatch; accepts only one worker', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const { service } = setup(db);
  const repos = new RepoRepository(db);
  const branches = new BranchRepository(db);
  const input = { branchId: branch.branch_id };
  await expect(service.clean(input, { user, tenant })).rejects.toThrow('disabled');
  await expect(
    service.clean({ ...input, command: 'override' } as { branchId: BranchID }, { user, tenant })
  ).rejects.toThrow('only branchId');
  await repos.update(branch.repo_id, {
    cleanup_policy: { enabled: true, command: './custom.sh', allow_branch_protection: true },
  });
  await expect(service.clean(input, { user, tenant })).rejects.toThrow('descendant containment');
  expect(requestExecutor).not.toHaveBeenCalled();
  expect(spawnExecutor).not.toHaveBeenCalled();
  await repos.update(branch.repo_id, {
    cleanup_policy: { enabled: true, command: 'git clean -fdX', allow_branch_protection: true },
  });
  await branches.update(branch.branch_id, { cleanup_protected: true });
  await expect(service.clean(input, { user, tenant })).rejects.toThrow('protected');
  await branches.update(branch.branch_id, {
    cleanup_protected: false,
    environment_instance: { status: 'running' },
  });
  await expect(service.clean(input, { user, tenant })).rejects.toThrow('environment is active');
  expect(spawnExecutor).not.toHaveBeenCalled();
  await branches.update(branch.branch_id, { environment_instance: { status: 'stopped' } });
  vi.mocked(requestExecutor).mockResolvedValueOnce({ success: true, data: { exists: false } });
  await expect(service.clean(input, { user, tenant })).rejects.toThrow('unavailable');
  const result = await service.clean(input, { user, tenant });
  expect(result.status).toBe('accepted');
  expect(spawnExecutor).toHaveBeenCalledOnce();
  expect(spawnExecutor).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'branch.clean',
      params: expect.objectContaining({
        branchId: branch.branch_id,
        cleanup: { command: 'git clean -fdX' },
      }),
    }),
    expect.anything()
  );
  expect((await branches.findById(branch.branch_id))?.archived).toBe(false);
  expect((await branches.findById(branch.branch_id))?.filesystem_status).toBe('ready');
  await expect(service.clean(input, { user, tenant })).rejects.toThrow('already active');
  expect(spawnExecutor).toHaveBeenCalledOnce();
});

test('Collaborators and read-only Managers cannot clean; Preserve needs management but no filesystem grant', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const member = await new UsersRepository(db).create({
    email: 'workspace-member@example.test',
    role: 'member',
  });
  const { service, archiveBranchSessions, emit } = setup(db);
  const board = await new BoardRepository(db).create({
    name: 'Archive fixture',
    created_by: user.user_id,
  });
  await new BranchRepository(db).update(branch.branch_id, { board_id: board.board_id });
  await new RepoRepository(db).update(branch.repo_id, {
    cleanup_policy: { enabled: true, command: 'true', allow_branch_protection: true },
  });
  await setTestBranchUserRole(
    db,
    branch.branch_id,
    member.user_id,
    'collaborator',
    'write',
    user.user_id
  );
  await expect(
    service.clean({ branchId: branch.branch_id }, { user: member, tenant })
  ).rejects.toThrow('Forbidden');
  await setTestBranchUserRole(
    db,
    branch.branch_id,
    member.user_id,
    'manager',
    'none',
    user.user_id
  );
  await expect(
    service.clean({ branchId: branch.branch_id }, { user: member, tenant })
  ).rejects.toThrow('filesystem write');
  const params = { user: member, tenant };
  markBranchArchiveDeleteAuthorized(params, branch.branch_id, 'archive');
  const result = await service.archiveOrDelete(
    branch.branch_id,
    { metadataAction: 'archive', filesystemAction: 'preserved' },
    params
  );
  expect(result).toMatchObject({
    archived: true,
    board_id: board.board_id,
    filesystem_status: 'ready',
    workspace_operation: { status: 'succeeded' },
  });
  expect(archiveBranchSessions).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenCalledWith(
    'patched',
    expect.objectContaining({ archived: true }),
    expect.anything()
  );
  expect(requestExecutor).not.toHaveBeenCalled();
  expect(spawnExecutor).not.toHaveBeenCalled();
  await expect(
    new BranchRepository(db).update(branch.branch_id, { notes: 'no maintenance remains' })
  ).resolves.toBeDefined();
});

test('archive removal uses the shared workspace worker and does not claim filesystem success on dispatch', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const { service } = setup(db);
  const params = { user, tenant };
  markBranchArchiveDeleteAuthorized(params, branch.branch_id, 'archive');
  await service.archiveOrDelete(
    branch.branch_id,
    { metadataAction: 'archive', filesystemAction: 'deleted' },
    params
  );
  expect(spawnExecutor).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'branch.archive',
      params: expect.objectContaining({
        filesystemAction: 'deleted',
        removal: expect.objectContaining({
          branchPath: branch.path,
          repoPath: '/tmp/environment-test',
        }),
      }),
    }),
    expect.anything()
  );
  const sent = vi.mocked(spawnExecutor).mock.calls[0]![0] as { params: Record<string, unknown> };
  expect(sent.params).not.toHaveProperty('cwd');
  expect(sent.params).not.toHaveProperty('cleanup');
  expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
    archived: true,
    filesystem_status: 'ready',
    workspace_operation: { status: 'accepted' },
  });
});

for (const binding of ['inherit', 'override'] as const) {
  for (const authority of ['owner', 'direct', 'group', 'superadmin', 'superadmin-owner'] as const) {
    test(`${binding} ${authority}: effective-access agrees with shared cleanup admission`, async ({
      db,
    }) => {
      const { branch: seed, user: creator } = await seedEnvironmentCommandBranch(db);
      const owner = await new UsersRepository(db).create({
        email: `${generateId()}@example.test`,
        role: authority === 'superadmin-owner' ? 'superadmin' : 'member',
      });
      const actor =
        authority === 'owner' || authority === 'superadmin-owner'
          ? owner
          : await new UsersRepository(db).create({
              email: `${generateId()}@example.test`,
              role: authority === 'superadmin' ? 'superadmin' : 'member',
            });
      const board = await new BoardRepository(db).create({
        name: 'Cleanup authority fixture',
        created_by: owner.user_id,
      });
      const repository = new BranchRepository(db);
      // Ownership is immutable today. Seed the historical transferred-owner state
      // directly at creation: creator is NOT primary owner, and has no ACL entry.
      const branch = await repository.create({
        repo_id: seed.repo_id,
        name: `owner-cleanup-${generateId()}`,
        ref: seed.ref,
        path: `/tmp/cleanup-owner-${generateId()}`,
        filesystem_status: 'ready',
        environment_instance: { status: 'stopped' },
        created_by: creator.user_id,
        branch_id: generateId() as BranchID,
        branch_unique_id: seed.branch_unique_id + 100000,
        primary_owner_user_id: owner.user_id,
        board_id: board.board_id,
        permission_binding: binding,
      });
      const policies = new CapabilityPolicyRepository(db);
      if (authority === 'direct' || authority === 'group') {
        const group = await new GroupRepository(db).create({
          name: `Managers ${generateId()}`,
          created_by: owner.user_id,
        });
        if (authority === 'group')
          await new GroupRepository(db).addMember(group.group_id, actor.user_id, owner.user_id);
        const entry = {
          entry_id: generateId(),
          principal:
            authority === 'direct'
              ? { principal_type: 'user' as const, user_id: actor.user_id }
              : { principal_type: 'group' as const, group_id: group.group_id },
          preset: 'manager' as const,
          fs_access: 'write' as const,
          capabilities: capabilityPolicyPresetCapabilities('branch_access', 'manager', 'write')!,
        };
        if (binding === 'inherit') {
          const current = await policies.getBoardPolicies(board.board_id);
          await policies.replaceBoardPolicies(
            board.board_id,
            {
              ...current,
              branch_template: {
                ...current.branch_template,
                access: {
                  ...current.branch_template.access,
                  sharing_mode: 'shared',
                  entries: [entry],
                },
              },
            },
            owner.user_id
          );
        } else {
          const current = await policies.getBranchPolicy(branch.branch_id);
          await policies.replaceBranchPolicy(
            branch.branch_id,
            {
              ...current,
              override_config: {
                ...current.override_config!,
                access: {
                  ...current.override_config!.access,
                  sharing_mode: 'shared',
                  entries: [entry],
                },
              },
            },
            owner.user_id
          );
        }
      }
      await new RepoRepository(db).update(branch.repo_id, {
        cleanup_policy: { enabled: true, command: 'git clean -fdX', allow_branch_protection: true },
      });
      let accessService!: { find(params: Params): Promise<EffectiveBranchAccess> };
      setupBranchEffectiveAccessService(
        {
          use: (_path: string, service: typeof accessService) => {
            accessService = service;
          },
        } as unknown as Application,
        repository,
        { allowSuperadmin: true }
      );
      const preview = await accessService.find({
        route: { id: branch.branch_id },
        user: actor,
      } as Params);
      expect(preview).toMatchObject({ can: 'all', fs_access: 'write' });
      expect((await repository.resolveUserAccess(branch, creator.user_id)).can).not.toBe('all');
      if (authority === 'superadmin') {
        await expect(
          setup(db).service.clean({ branchId: branch.branch_id }, { user: actor, tenant })
        ).rejects.toThrow('Forbidden');
      }
      const { service } = setup(db, true);
      await expect(
        service.clean({ branchId: branch.branch_id }, { user: creator, tenant })
      ).rejects.toThrow('Forbidden');
      // A successful preview is not an authorization token: fresh action admission
      // must reject an intervening policy revocation.
      if (authority === 'direct' || authority === 'group') {
        await setTestBranchUserRole(
          db,
          branch.branch_id,
          actor.user_id,
          'viewer',
          'read',
          owner.user_id
        );
        await expect(
          service.clean({ branchId: branch.branch_id }, { user: actor, tenant })
        ).rejects.toThrow('Forbidden');
        expect(spawnExecutor).not.toHaveBeenCalled();
        await setTestBranchUserRole(
          db,
          branch.branch_id,
          actor.user_id,
          'manager',
          'write',
          owner.user_id
        );
      }
      await expect(
        service.clean({ branchId: branch.branch_id }, { user: actor, tenant })
      ).resolves.toMatchObject({ status: 'accepted' });
      expect(spawnExecutor).toHaveBeenCalledOnce();
    });
  }
}

test('explicit Manager retirement clears revoked collaborators preferences, preserves files and retains board protection', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const { service } = setup(db);
  const branches = new BranchRepository(db);
  const boards = new BoardRepository(db);
  const prefs = new UserPrimaryTeammateRepository(db);
  const collaborator = await new UsersRepository(db).create({
    email: 'retirement-peer@example.test',
    role: 'member',
  });
  const board = await boards.create({ name: 'Retirement', created_by: user.user_id });
  await branches.update(branch.branch_id, {
    board_id: board.board_id,
    custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture' } },
  });
  await setTestBranchUserRole(
    db,
    branch.branch_id,
    collaborator.user_id,
    'collaborator',
    'write',
    user.user_id
  );
  await prefs.setPrimaryTeammate(collaborator.user_id, branch.branch_id, { source: 'explicit' });
  await expect(
    service.retireTeammate(branch.branch_id, { user: collaborator, tenant })
  ).rejects.toThrow(/Manager/);
  // Revocation does not require cooperation from the preference holder.
  await setTestBranchUserRole(
    db,
    branch.branch_id,
    collaborator.user_id,
    'viewer',
    'none',
    user.user_id
  );
  await boards.setPrimaryTeammate(board.board_id, branch.branch_id);
  await expect(service.retireTeammate(branch.branch_id, { user, tenant })).rejects.toThrow(
    'Primary teammate is protected'
  );
  expect(await prefs.getBranchId(collaborator.user_id)).toBe(branch.branch_id);
  expect((await branches.findById(branch.branch_id))?.archived).toBe(false);
  await boards.clearPrimaryTeammate(board.board_id);
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    created_by: user.user_id,
    agentic_tool: 'codex',
  });
  const task = await new TaskRepository(db).create({
    session_id: session.session_id,
    created_by: user.user_id,
    status: 'queued',
  });
  await expect(service.retireTeammate(branch.branch_id, { user, tenant })).rejects.toThrow(
    'unfinished tasks'
  );
  expect(await prefs.getBranchId(collaborator.user_id)).toBe(branch.branch_id);
  expect((await branches.findById(branch.branch_id))?.archived).toBe(false);
  await new TaskRepository(db).update(task.task_id, { status: 'stopped' });
  await service.retireTeammate(branch.branch_id, { user, tenant });
  expect(await prefs.getBranchId(collaborator.user_id)).toBeNull();
  expect(await branches.findById(branch.branch_id)).toMatchObject({
    archived: true,
    path: branch.path,
    filesystem_status: 'ready',
  });
  expect(spawnExecutor).not.toHaveBeenCalled();
  expect(requestExecutor).not.toHaveBeenCalled();
  await expect(
    prefs.setPrimaryTeammate(user.user_id, branch.branch_id, { source: 'explicit' })
  ).rejects.toThrow(/active/);
});
