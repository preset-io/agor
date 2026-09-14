import { BoardRepository, BranchRepository, RepoRepository, UsersRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, TenantID } from '@agor/core/types';
import { beforeEach, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import {
  setTestBranchUserRole,
  ownedDbTest as test,
} from '../../../../packages/core/src/db/test-helpers';
import { markBranchArchiveDeleteAuthorized } from '../utils/branch-archive-delete-authorization';
import { requestExecutor, spawnExecutor } from '../utils/spawn-executor';
import { BranchesService } from './branches';

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
function setup(db: ConstructorParameters<typeof BranchesService>[0]) {
  const archiveBranchSessions = vi.fn().mockResolvedValue({ count: 0 });
  const emit = vi.fn();
  const app = {
    get: () => ({ execution: {} }),
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
