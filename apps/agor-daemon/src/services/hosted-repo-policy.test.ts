import type { Application, Branch, Repo } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleService } from '../adapters/drizzle';
import { BranchesService } from './branches';
import { ReposService } from './repos';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    resolveMultiTenancyConfig: vi.fn(() => ({ mode: 'required_from_auth' })),
  };
});

describe('hosted repository storage policy canonical boundaries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects worktree rows through the exposed branches.create boundary', async () => {
    const service = new BranchesService(
      {} as never,
      { get: () => ({}), service: vi.fn() } as unknown as Application
    );

    await expect(
      service.create({
        board_id: '550e8400-e29b-41d4-a716-446655440000',
        storage_mode: 'worktree',
      } as Partial<Branch>)
    ).rejects.toThrow(/worktree.*unavailable in hosted multi-tenant mode/);
  });

  it('rejects bulk conversion to local repositories', async () => {
    const service = new ReposService(
      {} as never,
      { get: () => ({}), service: vi.fn() } as unknown as Application
    );

    await expect(service.patch(null, { repo_type: 'local' })).rejects.toThrow(
      /Bulk conversion to local repositories is unavailable/
    );
  });

  it('allows unrelated updates to historical local repository rows', async () => {
    const patched = { repo_id: 'repo-1', repo_type: 'local', slug: 'renamed' } as Repo;
    const adapterPatch = vi.spyOn(DrizzleService.prototype, 'patch').mockResolvedValue(patched);
    const service = new ReposService(
      {} as never,
      { get: () => ({}), service: vi.fn() } as unknown as Application
    );

    await expect(service.patch('repo-1', { slug: 'renamed' })).resolves.toBe(patched);
    expect(adapterPatch).toHaveBeenCalledWith('repo-1', { slug: 'renamed' }, undefined);
  });
});
