import { describe, expect, it } from 'vitest';
import type { Repo, RepoSlug, UUID, Worktree } from '../types';
import {
  getDefaultRepoReference,
  getGroupedRepoReferenceOptions,
  getRepoReferenceOptions,
} from './repo-list';

describe('getRepoReferenceOptions', () => {
  it('should return empty array when no repos provided', () => {
    const result = getRepoReferenceOptions([]);
    expect(result).toEqual([]);
  });

  it('should create managed repo option with correct structure', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const result = getRepoReferenceOptions(repos);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      label: 'preset-io/agor',
      value: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f',
      type: 'managed',
      slug: 'preset-io/agor',
      description: 'Agor (bare repo)',
    });
  });

  it('should create worktree options with correct structure', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_01933e4b1234a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/Users/max/.agor/worktrees/preset-io/agor/main',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'abc123',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getRepoReferenceOptions(repos, worktrees);

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      label: 'preset-io/agor:main',
      value: 'wt_01933e4b1234a8f39d2e1c4b5a6f7c35',
      type: 'managed-worktree',
      slug: 'preset-io/agor',
      worktree: 'main',
      description: 'Agor - main (refs/heads/main)',
    });
  });

  it('should handle multiple repos and worktrees', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
      {
        repo_id: 'repo_01934c2d56787c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'apache/superset' as RepoSlug,
        name: 'Superset',
        remote_url: 'https://github.com/apache/superset.git',
        local_path: '/Users/max/.agor/repos/apache/superset',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_01933e4b1234a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/Users/max/.agor/worktrees/preset-io/agor/main',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'abc123',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
      {
        worktree_id: 'wt_01933e4c5678a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 2,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'feat-auth',
        path: '/Users/max/.agor/worktrees/preset-io/agor/feat-auth',
        ref: 'refs/heads/feat-auth',
        new_branch: true,
        last_commit_sha: 'def456',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
      {
        worktree_id: 'wt_01934c2e9012a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01934c2d56787c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 3,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/Users/max/.agor/worktrees/apache/superset/main',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'ghi789',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getRepoReferenceOptions(repos, worktrees);

    expect(result).toHaveLength(5);

    expect(result[0].label).toBe('preset-io/agor');
    expect(result[0].type).toBe('managed');

    expect(result[1].label).toBe('apache/superset');
    expect(result[1].type).toBe('managed');

    expect(result[2].label).toBe('preset-io/agor:main');
    expect(result[2].type).toBe('managed-worktree');

    expect(result[3].label).toBe('preset-io/agor:feat-auth');
    expect(result[3].type).toBe('managed-worktree');

    expect(result[4].label).toBe('apache/superset:main');
    expect(result[4].type).toBe('managed-worktree');
  });

  it('should skip orphaned worktrees without matching repo', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_01933e4b1234a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/Users/max/.agor/worktrees/preset-io/agor/main',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'abc123',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
      {
        worktree_id: 'wt_orphaned1234a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_nonexistent' as UUID,
        worktree_unique_id: 2,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'orphan-branch',
        path: '/Users/max/.agor/worktrees/orphaned/branch',
        ref: 'refs/heads/orphan',
        new_branch: false,
        last_commit_sha: 'xyz999',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getRepoReferenceOptions(repos, worktrees);

    expect(result).toHaveLength(2);
    expect(result.some(opt => opt.worktree === 'orphan-branch')).toBe(false);
    expect(result.some(opt => opt.worktree === 'main')).toBe(true);
  });

  it('should handle repos without worktrees', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
      {
        repo_id: 'repo_01934c2d56787c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'apache/superset' as RepoSlug,
        name: 'Superset',
        remote_url: 'https://github.com/apache/superset.git',
        local_path: '/Users/max/.agor/repos/apache/superset',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const result = getRepoReferenceOptions(repos, []);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('managed');
    expect(result[1].type).toBe('managed');
    expect(result.every(opt => opt.type === 'managed')).toBe(true);
  });

  it('should use correct ID values for repo and worktree options', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_test123' as UUID,
        slug: 'test/repo' as RepoSlug,
        name: 'Test Repo',
        remote_url: 'https://github.com/test/repo.git',
        local_path: '/test/bare',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_test456' as UUID,
        repo_id: 'repo_test123' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_test' as UUID,
        name: 'main',
        path: '/test/worktree',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'abc',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getRepoReferenceOptions(repos, worktrees);

    expect(result[0].value).toBe('repo_test123');
    expect(result[1].value).toBe('wt_test456');
  });

  it('should format label and description correctly', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'org/project' as RepoSlug,
        name: 'My Project',
        remote_url: 'https://github.com/org/project.git',
        local_path: '/path/to/bare',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_01933e4b1234a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'feature-x',
        path: '/path/to/worktree',
        ref: 'refs/heads/feature-x',
        new_branch: true,
        last_commit_sha: 'commit123',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getRepoReferenceOptions(repos, worktrees);

    expect(result[0].label).toBe('org/project');
    expect(result[0].description).toBe('My Project (bare repo)');

    expect(result[1].label).toBe('org/project:feature-x');
    expect(result[1].description).toBe('My Project - feature-x (refs/heads/feature-x)');
  });
});

describe('getGroupedRepoReferenceOptions', () => {
  it('should return empty object when no repos provided', () => {
    const result = getGroupedRepoReferenceOptions([]);
    expect(result).toEqual({});
  });

  it('should group by repo slug', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
      {
        repo_id: 'repo_01934c2d56787c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'apache/superset' as RepoSlug,
        name: 'Superset',
        remote_url: 'https://github.com/apache/superset.git',
        local_path: '/Users/max/.agor/repos/apache/superset',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const result = getGroupedRepoReferenceOptions(repos);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['preset-io/agor']).toBeDefined();
    expect(result['apache/superset']).toBeDefined();
  });

  it('should include bare repo as first option in each group', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const result = getGroupedRepoReferenceOptions(repos);

    expect(result['preset-io/agor']).toHaveLength(1);
    expect(result['preset-io/agor'][0]).toEqual({
      label: 'preset-io/agor',
      value: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f',
      type: 'managed',
      slug: 'preset-io/agor',
      description: 'Agor (bare repo)',
    });
  });

  it('should group worktrees under their repos', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_01933e4b1234a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/Users/max/.agor/worktrees/preset-io/agor/main',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'abc123',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
      {
        worktree_id: 'wt_01933e4c5678a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 2,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'feat-auth',
        path: '/Users/max/.agor/worktrees/preset-io/agor/feat-auth',
        ref: 'refs/heads/feat-auth',
        new_branch: true,
        last_commit_sha: 'def456',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getGroupedRepoReferenceOptions(repos, worktrees);

    expect(result['preset-io/agor']).toHaveLength(3);
    expect(result['preset-io/agor'][0].type).toBe('managed');
    expect(result['preset-io/agor'][1].type).toBe('managed-worktree');
    expect(result['preset-io/agor'][2].type).toBe('managed-worktree');
    expect(result['preset-io/agor'][1].worktree).toBe('main');
    expect(result['preset-io/agor'][2].worktree).toBe('feat-auth');
  });

  it('should maintain separate groups for multiple repos', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
      {
        repo_id: 'repo_01934c2d56787c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'apache/superset' as RepoSlug,
        name: 'Superset',
        remote_url: 'https://github.com/apache/superset.git',
        local_path: '/Users/max/.agor/repos/apache/superset',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_agor_main' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/path/agor/main',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'abc',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
      {
        worktree_id: 'wt_superset_main' as UUID,
        repo_id: 'repo_01934c2d56787c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 2,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/path/superset/main',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'def',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getGroupedRepoReferenceOptions(repos, worktrees);

    expect(result['preset-io/agor']).toHaveLength(2);
    expect(result['apache/superset']).toHaveLength(2);
    expect(result['preset-io/agor'][1].label).toBe('preset-io/agor:main');
    expect(result['apache/superset'][1].label).toBe('apache/superset:main');
  });

  it('should skip orphaned worktrees without matching repo', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_valid' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/path/valid',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'abc',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
      {
        worktree_id: 'wt_orphan' as UUID,
        repo_id: 'repo_nonexistent' as UUID,
        worktree_unique_id: 2,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'orphan',
        path: '/path/orphan',
        ref: 'refs/heads/orphan',
        new_branch: false,
        last_commit_sha: 'xyz',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getGroupedRepoReferenceOptions(repos, worktrees);

    expect(result['preset-io/agor']).toHaveLength(2);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['preset-io/agor'].some(opt => opt.worktree === 'orphan')).toBe(false);
  });

  it('should handle repos without worktrees', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
      {
        repo_id: 'repo_01934c2d56787c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'apache/superset' as RepoSlug,
        name: 'Superset',
        remote_url: 'https://github.com/apache/superset.git',
        local_path: '/Users/max/.agor/repos/apache/superset',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const result = getGroupedRepoReferenceOptions(repos, []);

    expect(result['preset-io/agor']).toHaveLength(1);
    expect(result['apache/superset']).toHaveLength(1);
    expect(result['preset-io/agor'][0].type).toBe('managed');
    expect(result['apache/superset'][0].type).toBe('managed');
  });

  it('should create group even if only worktrees exist for that repo', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_01933e4b1234a8f39d2e1c4b5a6f7c35' as UUID,
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        name: 'main',
        path: '/path/main',
        ref: 'refs/heads/main',
        new_branch: false,
        last_commit_sha: 'abc',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getGroupedRepoReferenceOptions(repos, worktrees);

    expect(result['preset-io/agor']).toBeDefined();
    expect(result['preset-io/agor']).toHaveLength(2);
  });

  it('should use correct structure for each option in groups', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_test' as UUID,
        slug: 'test/repo' as RepoSlug,
        name: 'Test',
        remote_url: 'https://github.com/test/repo.git',
        local_path: '/test/bare',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const worktrees: Worktree[] = [
      {
        worktree_id: 'wt_test' as UUID,
        repo_id: 'repo_test' as UUID,
        worktree_unique_id: 1,
        created_by: 'user_test' as UUID,
        name: 'dev',
        path: '/test/dev',
        ref: 'refs/heads/dev',
        new_branch: false,
        last_commit_sha: 'abc',
        created_at: new Date('2024-01-01').toISOString(),
        updated_at: new Date('2024-01-01').toISOString(),
        last_used: new Date('2024-01-01').toISOString(),
        schedule_enabled: false,
        needs_attention: false,
      },
    ];

    const result = getGroupedRepoReferenceOptions(repos, worktrees);

    const bareOption = result['test/repo'][0];
    expect(bareOption.label).toBe('test/repo');
    expect(bareOption.value).toBe('repo_test');
    expect(bareOption.type).toBe('managed');
    expect(bareOption.slug).toBe('test/repo');
    expect(bareOption.description).toBe('Test (bare repo)');

    const worktreeOption = result['test/repo'][1];
    expect(worktreeOption.label).toBe('test/repo:dev');
    expect(worktreeOption.value).toBe('wt_test');
    expect(worktreeOption.type).toBe('managed-worktree');
    expect(worktreeOption.slug).toBe('test/repo');
    expect(worktreeOption.worktree).toBe('dev');
    expect(worktreeOption.description).toBe('Test - dev (refs/heads/dev)');
  });
});

describe('getDefaultRepoReference', () => {
  it('should return undefined for empty array', () => {
    const result = getDefaultRepoReference([]);
    expect(result).toBeUndefined();
  });

  it('should return slug of first repo', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const result = getDefaultRepoReference(repos);
    expect(result).toBe('preset-io/agor');
  });

  it('should return first repo when multiple repos exist', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_01933e4a7b897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'preset-io/agor' as RepoSlug,
        name: 'Agor',
        remote_url: 'https://github.com/preset-io/agor.git',
        local_path: '/Users/max/.agor/repos/preset-io/agor',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
      {
        repo_id: 'repo_01934c2d56787c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'apache/superset' as RepoSlug,
        name: 'Superset',
        remote_url: 'https://github.com/apache/superset.git',
        local_path: '/Users/max/.agor/repos/apache/superset',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
      {
        repo_id: 'repo_01935d3e67897c35a8f39d2e1c4b5a6f' as UUID,
        slug: 'facebook/react' as RepoSlug,
        name: 'React',
        remote_url: 'https://github.com/facebook/react.git',
        local_path: '/Users/max/.agor/repos/facebook/react',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const result = getDefaultRepoReference(repos);
    expect(result).toBe('preset-io/agor');
  });

  it('should not be affected by repo order', () => {
    const repos: Repo[] = [
      {
        repo_id: 'repo_z' as UUID,
        slug: 'z/last' as RepoSlug,
        name: 'Last',
        remote_url: 'https://github.com/z/last.git',
        local_path: '/z/bare',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
      {
        repo_id: 'repo_a' as UUID,
        slug: 'a/first' as RepoSlug,
        name: 'First',
        remote_url: 'https://github.com/a/first.git',
        local_path: '/a/bare',
        created_at: new Date('2024-01-01').toISOString(),
        last_updated: new Date('2024-01-01').toISOString(),
      },
    ];

    const result = getDefaultRepoReference(repos);
    expect(result).toBe('z/last');
  });
});
