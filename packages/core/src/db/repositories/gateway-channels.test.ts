/**
 * GatewayChannelRepository Tests
 *
 * Covers the created_by requirement — the contract that the
 * injectCreatedBy() hook must satisfy before calling create().
 */

import type { UUID, WorktreeID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';
import { WorktreeRepository } from './worktrees';

async function seedWorktree(db: Database) {
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

  const worktreeRepo = new WorktreeRepository(db);
  const worktree = await worktreeRepo.create({
    worktree_id: generateId() as WorktreeID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    worktree_unique_id: 1,
    path: '/home/user/.agor/worktrees/test/repo/main',
    created_by: generateId() as UUID,
  });

  return worktree;
}

describe('GatewayChannelRepository', () => {
  dbTest('create throws when created_by is missing', async ({ db }) => {
    const repo = new GatewayChannelRepository(db);
    await expect(repo.create({ name: 'Test Channel' })).rejects.toThrow(
      'GatewayChannel must have a created_by'
    );
  });

  dbTest('create stamps created_by on the returned channel', async ({ db }) => {
    const worktree = await seedWorktree(db);
    const repo = new GatewayChannelRepository(db);
    const userId = generateId() as UUID;

    const channel = await repo.create({
      name: 'Test Channel',
      created_by: userId,
      target_worktree_id: worktree.worktree_id as UUID,
    });

    expect(channel.created_by).toBe(userId);
    expect(channel.name).toBe('Test Channel');
    expect(channel.id).toBeDefined();
  });
});
