import type { BranchRepository } from '@agor/core/db';
import type { Branch, EffectiveBranchAccess, UserID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { ensureBranchWorkspaceAccess } from './branch-workspace-path.js';

const userId = '00000000-0000-7000-8000-000000000001' as UserID;
const branch = {
  branch_id: '00000000-0000-7000-8000-000000000002',
  primary_owner_user_id: '00000000-0000-7000-8000-000000000003',
} as Branch;

function repository(access: EffectiveBranchAccess): BranchRepository {
  return {
    resolveUserAccess: vi.fn(async () => access),
  } as unknown as BranchRepository;
}

function access(
  can: EffectiveBranchAccess['can'],
  fsAccess: NonNullable<EffectiveBranchAccess['fs_access']>,
  isOwner = false
): EffectiveBranchAccess {
  return {
    can,
    fs_access: fsAccess,
    is_owner: isOwner,
    source: isOwner ? 'owner' : 'others',
  };
}

describe('ensureBranchWorkspaceAccess', () => {
  it('requires both the application role and requested filesystem access', async () => {
    await expect(
      ensureBranchWorkspaceAccess(repository(access('session', 'read')), branch, userId, 'member')
    ).resolves.toBe('read');
    await expect(
      ensureBranchWorkspaceAccess(
        repository(access('view', 'write')),
        branch,
        userId,
        'member',
        'session',
        'read'
      )
    ).rejects.toThrow('branch session permission required');
    await expect(
      ensureBranchWorkspaceAccess(
        repository(access('session', 'none')),
        branch,
        userId,
        'member',
        'session',
        'read'
      )
    ).rejects.toThrow('filesystem read access required');
  });

  it('distinguishes read from write operations', async () => {
    const readOnly = repository(access('session', 'read'));
    await expect(
      ensureBranchWorkspaceAccess(readOnly, branch, userId, 'member', 'session', 'read')
    ).resolves.toBe('read');
    await expect(
      ensureBranchWorkspaceAccess(readOnly, branch, userId, 'member', 'session', 'write')
    ).rejects.toThrow('filesystem write access required');
  });

  it('retains owner authority and gates the superadmin bypass by configuration', async () => {
    await expect(
      ensureBranchWorkspaceAccess(
        repository(access('all', 'write', true)),
        branch,
        userId,
        'member',
        'session',
        'write'
      )
    ).resolves.toBe('write');
    await expect(
      ensureBranchWorkspaceAccess(
        repository(access('none', 'none')),
        branch,
        userId,
        'superadmin',
        'session',
        'write',
        true
      )
    ).resolves.toBe('write');
    await expect(
      ensureBranchWorkspaceAccess(
        repository(access('none', 'none')),
        branch,
        userId,
        'superadmin',
        'session',
        'write',
        false
      )
    ).rejects.toThrow('branch session permission required');
  });
});
