import { BranchRepository, RepoRepository, UsersRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, TenantID } from '@agor/core/types';
import { expect } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { markBranchArchiveDeleteAuthorized } from '../utils/branch-archive-delete-authorization';
import { BranchesService } from './branches';

const app = { get: () => ({}) } as unknown as Application;

dbTest(
  'archive Clean rejects disabled and protected policy before metadata changes',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const service = new BranchesService(db, app);
    const repoRepository = new RepoRepository(db);
    const branchRepository = new BranchRepository(db);
    const rejectClean = async (message: string) => {
      const params = {
        user,
        tenant: { tenant_id: 'default' as TenantID, source: 'explicit' as const },
      };
      markBranchArchiveDeleteAuthorized(params, branch.branch_id, 'archive');
      await expect(
        service.archiveOrDelete(
          branch.branch_id,
          { metadataAction: 'archive', filesystemAction: 'cleaned' },
          params
        )
      ).rejects.toThrow(message);
      expect((await branchRepository.findById(branch.branch_id))?.archived).not.toBe(true);
    };
    await rejectClean('Cleanup is disabled');
    await repoRepository.update(branch.repo_id, {
      cleanup_policy: { enabled: true, command: 'git clean -fdX', allow_branch_protection: true },
    });
    await branchRepository.update(branch.branch_id, { cleanup_protected: true });
    await rejectClean('protected from workspace cleanup');
  }
);

dbTest(
  'owner and Manager can preprotect while policy is disabled; Collaborator cannot',
  async ({ db }) => {
    const { branch, user: owner } = await seedEnvironmentCommandBranch(db);
    const member = await new UsersRepository(db).create({
      email: 'cleanup-manager@example.test',
      role: 'member',
    });
    const service = new BranchesService(db, app);
    await expect(
      service.patch(branch.branch_id, { cleanup_protected: true }, { user: owner })
    ).resolves.toMatchObject({ cleanup_protected: true });
    // Protection management does not require workspace execution access.
    await setTestBranchUserRole(
      db,
      branch.branch_id,
      member.user_id,
      'manager',
      'none',
      owner.user_id
    );
    await expect(
      service.patch(branch.branch_id, { cleanup_protected: false }, { user: member })
    ).resolves.toMatchObject({ cleanup_protected: false });
    await setTestBranchUserRole(
      db,
      branch.branch_id,
      member.user_id,
      'collaborator',
      'write',
      owner.user_id
    );
    await expect(
      service.patch(branch.branch_id, { cleanup_protected: true }, { user: member })
    ).rejects.toThrow('Branch Manager access');
    await expect(
      service.update(branch.branch_id, { cleanup_protected: true }, { user: member })
    ).rejects.toThrow('Branch Manager access');
    expect((await new BranchRepository(db).findById(branch.branch_id))?.cleanup_protected).toBe(
      false
    );
  }
);

dbTest(
  'invalid values, anonymous writes, and repo overrides cannot change saved protection',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const service = new BranchesService(db, app);
    for (const value of ['true', null, undefined, 1]) {
      const data = { cleanup_protected: value } as unknown as Partial<Branch>;
      await expect(service.patch(branch.branch_id, data, { user })).rejects.toThrow(
        'must be a boolean'
      );
    }
    await expect(service.patch(branch.branch_id, { cleanup_protected: true })).rejects.toThrow(
      'Authentication required'
    );
    await service.patch(branch.branch_id, { cleanup_protected: true }, { user });
    await new RepoRepository(db).update(branch.repo_id, {
      cleanup_policy: { enabled: false, command: 'git clean -fdX', allow_branch_protection: false },
    });
    await expect(
      service.patch(branch.branch_id, { cleanup_protected: false }, { user })
    ).rejects.toThrow('Repository policy currently overrides');
    expect((await new BranchRepository(db).findById(branch.branch_id))?.cleanup_protected).toBe(
      true
    );
  }
);
