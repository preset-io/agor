/**
 * GatewayChannelRepository Tests
 *
 * Covers the created_by requirement — the contract that the
 * injectCreatedBy() hook must satisfy before calling create().
 */

import type { BranchID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';

async function seedBranch(db: Database) {
  const repoRepo = new RepoRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId() as UUID,
    slug: 'test/repo',
    name: 'test-repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/home/user/.agor/repos/test-repo',
    default_branch: 'main',
  });

  const branchRepo = new BranchRepository(db);
  const branch = await branchRepo.create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    branch_unique_id: 1,
    path: '/home/user/.agor/worktrees/test/repo/main',
    created_by: generateId() as UUID,
  });

  return branch;
}

describe('GatewayChannelRepository', () => {
  dbTest('create throws when created_by is missing', async ({ db }) => {
    const repo = new GatewayChannelRepository(db);
    await expect(repo.create({ name: 'Test Channel' })).rejects.toThrow(
      'GatewayChannel must have a created_by'
    );
  });

  dbTest('create stamps created_by on the returned channel', async ({ db }) => {
    const branch = await seedBranch(db);
    const repo = new GatewayChannelRepository(db);
    const userId = generateId() as UUID;

    const channel = await repo.create({
      name: 'Test Channel',
      created_by: userId,
      target_branch_id: branch.branch_id as UUID,
    });

    expect(channel.created_by).toBe(userId);
    expect(channel.name).toBe('Test Channel');
    expect(channel.id).toBeDefined();
  });
});
