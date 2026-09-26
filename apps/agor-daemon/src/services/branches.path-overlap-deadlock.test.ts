import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  RepoRepository,
  runWithTenantContext,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { simpleGit } from '@agor/core/git/exec';
import type { AuthenticatedParams, BranchID, TenantID } from '@agor/core/types';
import { beforeEach, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { ownedDbTest as test } from '../../../../packages/core/src/db/test-helpers';
import { markBranchArchiveDeleteAuthorized } from '../utils/branch-archive-delete-authorization';
import { requestExecutor, spawnExecutor } from '../utils/spawn-executor';
import { BranchesService } from './branches';

vi.mock('../utils/spawn-executor', async (original) => ({
  ...(await original<object>()),
  spawnExecutor: vi.fn(),
  requestExecutor: vi.fn(),
}));

/**
 * SC-121372: two Branch rows that ended up sharing a filesystem path used to
 * deadlock archive/delete permanently. These exercise the exact service
 * method the `/branches/:id/archive-or-delete` route (and therefore the
 * `agor_branches_delete` MCP tool) calls, not the repository guard directly.
 */
function buildApp(): Application {
  return {
    get: () => ({ execution: {} }),
    emit: vi.fn(),
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'fixture-command-token') },
    service: () => ({ emit: vi.fn(), archiveBranchSessions: vi.fn() }),
  } as unknown as Application;
}

function paramsFor(user: { user_id: string }): AuthenticatedParams {
  return {
    provider: 'mcp',
    user,
    tenant: { tenant_id: 'default' as TenantID, source: 'explicit' },
  } as AuthenticatedParams;
}

function serviceWithMockedGet(db: Database, app = buildApp()) {
  const service = new BranchesService(createTenantScopedDatabaseProxy(db), app);
  vi.spyOn(service, 'get').mockImplementation(
    async (id: BranchID) => (await new BranchRepository(db).findById(id))! as never
  );
  vi.spyOn(
    service as unknown as {
      resolveEnvironmentExecutorContext: BranchesService['resolveEnvironmentExecutorContext'];
    },
    'resolveEnvironmentExecutorContext'
  ).mockImplementation(async (branch) => ({
    env: {},
    executionUserId: branch.created_by,
    branchFsAccess: 'write',
    sandboxMounts: {},
  }));
  return service;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawnExecutor).mockReset();
});

for (const status of ['failed', 'cleaned', 'deleted'] as const) {
  test(`metadata-only archive escapes overlapping ${status} rows without filesystem work`, async ({
    db,
  }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const branches = new BranchRepository(db);
    await branches.update(branch.branch_id, { filesystem_status: status });
    const sibling = await branches.create({
      repo_id: branch.repo_id,
      name: 'sibling',
      ref: 'sibling',
      branch_unique_id: 9700001,
      path: branch.path,
      created_by: user.user_id,
      filesystem_status: status,
    });
    const app = buildApp();
    const service = serviceWithMockedGet(db, app);
    await runWithTenantContext('default', async () => {
      for (const row of [branch, sibling]) {
        const params = paramsFor(user);
        markBranchArchiveDeleteAuthorized(params, row.branch_id, 'archive');
        await expect(
          service.archiveOrDelete(
            row.branch_id,
            {
              metadataAction: 'archive',
              filesystemAction: 'preserved',
            },
            params
          )
        ).resolves.toMatchObject({
          archived: true,
          filesystem_status: status,
          workspace_operation: { status: 'succeeded', filesystem_action: 'preserved' },
        });
      }
      // Archival is not evidence that either workspace is safe to delete.
      const params = paramsFor(user);
      markBranchArchiveDeleteAuthorized(params, branch.branch_id, 'delete');
      await expect(
        service.archiveOrDelete(
          branch.branch_id,
          {
            metadataAction: 'delete',
            filesystemAction: 'deleted',
          },
          params
        )
      ).rejects.toThrow('overlaps');
    });
    expect(spawnExecutor).not.toHaveBeenCalled();
    expect(requestExecutor).not.toHaveBeenCalled();
    expect(app.emit).not.toHaveBeenCalledWith('terminal:close-branch', expect.anything());
  });
}

for (const status of ['cleaned', 'failed'] as const) {
  test(`retained ${status} sibling files block deletion and archive filesystem operations`, async ({
    db,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'agor-overlap-retained-'));
    try {
      await writeFile(join(root, 'tracked.txt'), 'retained tracked content');
      await writeFile(join(root, 'untracked.txt'), 'retained ordinary untracked content');
      const git = simpleGit(root);
      await git.init();
      await git.add('tracked.txt');
      expect((await git.status()).not_added).toContain('untracked.txt');
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const branches = new BranchRepository(db);
      await branches.update(branch.branch_id, { path: root });
      const sibling = await branches.create({
        repo_id: branch.repo_id,
        name: 'retained',
        ref: 'retained',
        branch_unique_id: 9700002,
        path: root,
        created_by: user.user_id,
        filesystem_status: status,
        archived: true,
      });
      await new RepoRepository(db).update(branch.repo_id, {
        cleanup_policy: { enabled: true, command: 'git clean -fdX', allow_branch_protection: true },
      });
      const app = buildApp();
      const service = serviceWithMockedGet(db, app);
      await runWithTenantContext('default', async () => {
        for (const options of [
          { metadataAction: 'delete', filesystemAction: 'deleted' },
          { metadataAction: 'archive', filesystemAction: 'deleted' },
          { metadataAction: 'archive', filesystemAction: 'cleaned' },
        ] as const) {
          const params = paramsFor(user);
          markBranchArchiveDeleteAuthorized(params, branch.branch_id, options.metadataAction);
          await expect(service.archiveOrDelete(branch.branch_id, options, params)).rejects.toThrow(
            'overlaps'
          );
        }
      });
      expect(spawnExecutor).not.toHaveBeenCalled();
      expect(requestExecutor).not.toHaveBeenCalled();
      expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('retained tracked content');
      expect(await readFile(join(root, 'untracked.txt'), 'utf8')).toBe(
        'retained ordinary untracked content'
      );
      expect(await branches.findById(branch.branch_id)).toMatchObject({ archived: false });
      expect((await branches.findById(branch.branch_id))?.deletion_status).toBeUndefined();
      expect(await branches.findById(sibling.branch_id)).toMatchObject({
        filesystem_status: status,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a failed sibling retry cannot race an admitted deletion of its shared workspace', async ({
  db,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'agor-overlap-retry-'));
  try {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const branches = new BranchRepository(db);
    await branches.update(branch.branch_id, { path: root });
    const sibling = await branches.create({
      repo_id: branch.repo_id,
      name: 'retry',
      ref: 'retry',
      branch_unique_id: 9700003,
      path: root,
      created_by: user.user_id,
      filesystem_status: 'failed',
    });
    const service = serviceWithMockedGet(db);
    // Hold the fake deletion worker until the sibling's real retry admission
    // has committed. The old exemption allows both distinct row locks to win.
    let removeWorkspace: (() => Promise<void>) | undefined;
    vi.mocked(spawnExecutor).mockImplementationOnce(() => {
      removeWorkspace = () => rm(root, { recursive: true, force: true });
    });
    await runWithTenantContext('default', async () => {
      const params = paramsFor(user);
      markBranchArchiveDeleteAuthorized(params, branch.branch_id, 'delete');
      const deletion = await service
        .archiveOrDelete(
          branch.branch_id,
          {
            metadataAction: 'delete',
            filesystemAction: 'deleted',
          },
          params
        )
        .then(
          () => 'admitted',
          (error: Error) => error.message
        );
      const retry = await branches.claimForProvisioning(sibling.branch_id, 'retry-attempt');
      expect(retry.claimed).toBe(true);
      await writeFile(join(root, 'new-workspace.txt'), 'retry content');
      await removeWorkspace?.();
      expect(await readFile(join(root, 'new-workspace.txt'), 'utf8')).toBe('retry content');
      expect(deletion).toContain('overlaps');
      expect(spawnExecutor).not.toHaveBeenCalled();
      expect((await branches.findById(branch.branch_id))?.deletion_status).toBeUndefined();
      // The reverse ordering (retry already creating) also remains protected.
      markBranchArchiveDeleteAuthorized(params, branch.branch_id, 'delete');
      await expect(
        service.archiveOrDelete(
          branch.branch_id,
          {
            metadataAction: 'delete',
            filesystemAction: 'deleted',
          },
          params
        )
      ).rejects.toThrow('overlaps');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
