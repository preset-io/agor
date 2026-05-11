/**
 * RepoRepository Tests
 *
 * Tests for type-safe CRUD operations on git repositories with short ID support.
 */

import type { UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError, RepositoryError } from './base';
import { RepoRepository } from './repos';

/**
 * Create test repo data
 */
function createRepoData(overrides?: {
  repo_id?: UUID;
  slug?: string;
  name?: string;
  repo_type?: 'remote' | 'local';
  remote_url?: string;
  local_path?: string;
  default_branch?: string;
}) {
  const slug = overrides?.slug ?? 'test-repo';
  return {
    repo_id: overrides?.repo_id ?? generateId(),
    slug,
    name: overrides?.name ?? slug,
    repo_type: overrides?.repo_type ?? 'remote',
    remote_url: overrides?.remote_url ?? 'https://github.com/test/repo.git',
    local_path: overrides?.local_path ?? `/home/user/.agor/repos/${slug}`,
    default_branch: overrides?.default_branch ?? 'main',
  };
}

// ============================================================================
// Create
// ============================================================================

describe('RepoRepository.create', () => {
  dbTest('should create repo with all fields', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();

    const created = await repo.create(data);

    expect(created.repo_id).toBe(data.repo_id);
    expect(created.slug).toBe(data.slug);
    expect(created.name).toBe(data.name);
    expect(created.repo_type).toBe('remote');
    expect(created.remote_url).toBe(data.remote_url);
    expect(created.local_path).toBe(data.local_path);
    expect(created.default_branch).toBe(data.default_branch);
    expect(created.created_at).toBeDefined();
    expect(created.last_updated).toBeDefined();
  });

  dbTest('should generate repo_id if not provided', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    delete (data as any).repo_id;

    const created = await repo.create(data);

    expect(created.repo_id).toBeDefined();
    expect(created.repo_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  dbTest('should default name to slug if not provided', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ slug: 'my-project' });
    delete (data as any).name;

    const created = await repo.create(data);

    expect(created.name).toBe('my-project');
  });

  dbTest('should throw error if slug is missing', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    delete (data as any).slug;

    await expect(repo.create(data)).rejects.toThrow(RepositoryError);
    await expect(repo.create(data)).rejects.toThrow('slug is required');
  });

  dbTest('should throw error if remote_url is missing', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    delete (data as any).remote_url;

    await expect(repo.create(data)).rejects.toThrow(RepositoryError);
    await expect(repo.create(data)).rejects.toThrow('Remote repos must have a remote_url');
  });

  dbTest('should allow local repo without remote_url', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({
      repo_type: 'local',
    });
    delete (data as any).remote_url;

    const created = await repo.create(data);

    expect(created.repo_type).toBe('local');
    expect(created.remote_url).toBeUndefined();
  });

  dbTest('should throw error if repo_type is missing', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    delete (data as any).repo_type;

    await expect(repo.create(data)).rejects.toThrow(RepositoryError);
    await expect(repo.create(data)).rejects.toThrow('repo_type is required when creating a repo');
  });

  dbTest('should throw error if local_path is missing', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    delete (data as any).local_path;

    await expect(repo.create(data)).rejects.toThrow(RepositoryError);
    await expect(repo.create(data)).rejects.toThrow('Repo must have a local_path');
  });

  dbTest('should handle environment_config', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    const repoWithConfig = {
      ...data,
      environment_config: {
        up_command: 'pnpm dev',
        down_command: 'pkill -f pnpm',
      },
    };

    const created = await repo.create(repoWithConfig);

    expect(created.environment_config).toEqual({
      up_command: 'pnpm dev',
      down_command: 'pkill -f pnpm',
    });
  });

  dbTest('should preserve timestamps if provided', async ({ db }) => {
    const repo = new RepoRepository(db);
    const createdAt = new Date('2024-01-01T00:00:00Z').toISOString();
    const lastUpdated = new Date('2024-01-02T00:00:00Z').toISOString();
    const data = {
      ...createRepoData(),
      created_at: createdAt,
      last_updated: lastUpdated,
    };

    const created = await repo.create(data);

    expect(created.created_at).toBe(createdAt);
    expect(created.last_updated).toBe(lastUpdated);
  });

  // Issue #1126 / Bug B: pre-#1126 a failed clone left zero state because the
  // executor only wrote the row on success. Pre-create + patch lets MCP
  // callers discover the outcome via `agor_repos_get(repoId)`.
  dbTest('should round-trip clone_status and clone_error through data blob', async ({ db }) => {
    const repo = new RepoRepository(db);
    const placeholder = await repo.create({
      ...createRepoData({ slug: 'test/cloning' }),
      clone_status: 'cloning',
    });
    expect(placeholder.clone_status).toBe('cloning');
    expect(placeholder.clone_error).toBeUndefined();

    const failed = await repo.update(placeholder.repo_id, {
      clone_status: 'failed',
      clone_error: {
        exit_code: 128,
        category: 'auth_failed',
        message: 'fatal: Authentication failed for github.com',
      },
    });
    expect(failed.clone_status).toBe('failed');
    expect(failed.clone_error?.category).toBe('auth_failed');
    expect(failed.clone_error?.exit_code).toBe(128);

    // findById must surface the same shape (catches a regression where
    // `rowToRepo` forgot to forward the new fields).
    const fetched = await repo.findById(placeholder.repo_id);
    expect(fetched?.clone_status).toBe('failed');
    expect(fetched?.clone_error?.category).toBe('auth_failed');
  });

  // The executor's success patch sends `clone_error: null` to drop the prior
  // failure shape from the row. `repoToInsert` coerces null → undefined so
  // the stored value matches the `clone_error?: RepoCloneError` invariant
  // (set only when failed). Without that coercion, the type would lie about
  // the shape of `repo.clone_error` after a recovery patch.
  dbTest(
    'should clear clone_error when success patch sends null (via deepMerge + repoToInsert)',
    async ({ db }) => {
      const repo = new RepoRepository(db);
      const placeholder = await repo.create({
        ...createRepoData({ slug: 'test/recovers' }),
        clone_status: 'failed',
        clone_error: {
          exit_code: 128,
          category: 'auth_failed',
          message: 'fatal: Authentication failed',
        },
      });
      expect(placeholder.clone_error?.category).toBe('auth_failed');

      // `null` is the explicit-clear signal honored by `deepMerge`. Cast to
      // mirror the executor's call site (Feathers' `Partial<Repo>` rejects
      // null on optional fields even when the merger handles it).
      const cleared = await repo.update(placeholder.repo_id, {
        clone_status: 'ready',
        clone_error: null as unknown as undefined,
      });
      expect(cleared.clone_status).toBe('ready');
      expect(cleared.clone_error).toBeUndefined();

      const refetched = await repo.findById(placeholder.repo_id);
      expect(refetched?.clone_error).toBeUndefined();
    }
  );
});

// ============================================================================
// FindById (with short ID support)
// ============================================================================

describe('RepoRepository.findById', () => {
  dbTest('should find repo by full UUID', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    const found = await repo.findById(data.repo_id);

    expect(found).not.toBeNull();
    expect(found?.repo_id).toBe(data.repo_id);
    expect(found?.slug).toBe(data.slug);
  });

  dbTest('should find repo by 8-char short ID', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    const shortId = data.repo_id.replace(/-/g, '').slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.repo_id).toBe(data.repo_id);
  });

  dbTest('should find repo by 12-char short ID', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    // Use only first 8 chars since resolveId uses simple LIKE without expanding hyphens
    // For 12+ chars, the pattern won't match UUIDs with hyphens in database
    const shortId = data.repo_id.replace(/-/g, '').slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.repo_id).toBe(data.repo_id);
  });

  dbTest('should handle short ID with hyphens', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    // Use first 8 chars with hyphen still in place (resolveId strips hyphens)
    const shortId = data.repo_id.slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.repo_id).toBe(data.repo_id);
  });

  dbTest('should be case-insensitive', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    const shortId = data.repo_id.replace(/-/g, '').slice(0, 8).toUpperCase();
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.repo_id).toBe(data.repo_id);
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const repo = new RepoRepository(db);

    const found = await repo.findById('99999999');

    expect(found).toBeNull();
  });

  dbTest('should throw AmbiguousIdError for ambiguous short ID', async ({ db }) => {
    const repo = new RepoRepository(db);

    // Create two repos with IDs that share the first 8 characters after hyphen removal
    const id1 = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-000000000000' as UUID;

    await repo.create(createRepoData({ repo_id: id1, slug: 'repo-1' }));
    await repo.create(createRepoData({ repo_id: id2, slug: 'repo-2' }));

    // Use first 8 chars which both IDs share
    const ambiguousPrefix = '01933e4a';

    await expect(repo.findById(ambiguousPrefix)).rejects.toThrow(AmbiguousIdError);
  });

  dbTest('should provide helpful suggestions for ambiguous ID', async ({ db }) => {
    const repo = new RepoRepository(db);

    const id1 = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-9d2e1c4b5a6f' as UUID;

    await repo.create(createRepoData({ repo_id: id1, slug: 'repo-1' }));
    await repo.create(createRepoData({ repo_id: id2, slug: 'repo-2' }));

    // Use short prefix that matches both
    const shortPrefix = '01933e4a';

    try {
      await repo.findById(shortPrefix);
      throw new Error('Expected AmbiguousIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousIdError);
      const ambiguousError = error as AmbiguousIdError;
      expect(ambiguousError.matches).toHaveLength(2);
      // formatShortId returns 8 chars by default
      expect(ambiguousError.matches[0]).toBe('01933e4a');
      expect(ambiguousError.matches[1]).toBe('01933e4a');
    }
  });
});

// ============================================================================
// FindBySlug
// ============================================================================

describe('RepoRepository.findBySlug', () => {
  dbTest('should find repo by exact slug match', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ slug: 'my-project' });
    await repo.create(data);

    const found = await repo.findBySlug('my-project');

    expect(found).not.toBeNull();
    expect(found?.slug).toBe('my-project');
    expect(found?.repo_id).toBe(data.repo_id);
  });

  dbTest('should return null for non-existent slug', async ({ db }) => {
    const repo = new RepoRepository(db);

    const found = await repo.findBySlug('non-existent');

    expect(found).toBeNull();
  });

  dbTest('should be case-sensitive for slugs', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ slug: 'my-project' });
    await repo.create(data);

    const found = await repo.findBySlug('MY-PROJECT');

    expect(found).toBeNull();
  });

  dbTest('should distinguish similar slugs', async ({ db }) => {
    const repo = new RepoRepository(db);
    await repo.create(createRepoData({ slug: 'project' }));
    await repo.create(createRepoData({ slug: 'project-2' }));

    const found = await repo.findBySlug('project');

    expect(found).not.toBeNull();
    expect(found?.slug).toBe('project');
  });
});

// ============================================================================
// FindAll
// ============================================================================

describe('RepoRepository.findAll', () => {
  dbTest('should return empty array when no repos', async ({ db }) => {
    const repo = new RepoRepository(db);

    const repos = await repo.findAll();

    expect(repos).toEqual([]);
  });

  dbTest('should return all repos', async ({ db }) => {
    const repo = new RepoRepository(db);

    const data1 = createRepoData({ slug: 'repo-1' });
    const data2 = createRepoData({ slug: 'repo-2' });
    const data3 = createRepoData({ slug: 'repo-3' });

    await repo.create(data1);
    await repo.create(data2);
    await repo.create(data3);

    const repos = await repo.findAll();

    expect(repos).toHaveLength(3);
    expect(repos.map((r) => r.slug).sort()).toEqual(['repo-1', 'repo-2', 'repo-3']);
  });

  dbTest('should return fully populated repo objects', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({
      slug: 'test',
      name: 'Test Project',
      remote_url: 'https://github.com/test/test.git',
    });
    await repo.create(data);

    const repos = await repo.findAll();

    expect(repos).toHaveLength(1);
    const found = repos[0];
    expect(found.repo_id).toBe(data.repo_id);
    expect(found.slug).toBe(data.slug);
    expect(found.name).toBe(data.name);
    expect(found.repo_type).toBe('remote');
    expect(found.remote_url).toBe(data.remote_url);
    expect(found.created_at).toBeDefined();
    expect(found.last_updated).toBeDefined();
  });
});

// ============================================================================
// FindManaged (deprecated)
// ============================================================================

describe('RepoRepository.findManaged', () => {
  dbTest('should return all repos (deprecated)', async ({ db }) => {
    const repo = new RepoRepository(db);

    await repo.create(createRepoData({ slug: 'repo-1' }));
    await repo.create(createRepoData({ slug: 'repo-2' }));

    const repos = await repo.findManaged();

    expect(repos).toHaveLength(2);
  });
});

// ============================================================================
// Update
// ============================================================================

describe('RepoRepository.update', () => {
  dbTest('should update repo by full UUID', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ name: 'Original Name' });
    await repo.create(data);

    const updated = await repo.update(data.repo_id, { name: 'Updated Name' });

    expect(updated.name).toBe('Updated Name');
    expect(updated.repo_id).toBe(data.repo_id);
    expect(updated.slug).toBe(data.slug); // Unchanged
    expect(updated.repo_type).toBe('remote');
  });

  dbTest('should update repo by short ID', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ default_branch: 'main' });
    await repo.create(data);

    const shortId = data.repo_id.replace(/-/g, '').slice(0, 8);
    const updated = await repo.update(shortId, { default_branch: 'develop' });

    expect(updated.default_branch).toBe('develop');
    expect(updated.repo_id).toBe(data.repo_id);
    expect(updated.repo_type).toBe('remote');
  });

  dbTest('should update multiple fields', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({
      name: 'Original',
      default_branch: 'main',
    });
    await repo.create(data);

    const updated = await repo.update(data.repo_id, {
      name: 'Updated',
      default_branch: 'develop',
      local_path: '/new/path',
    });

    expect(updated.name).toBe('Updated');
    expect(updated.default_branch).toBe('develop');
    expect(updated.local_path).toBe('/new/path');
  });

  dbTest('should update local repo without requiring remote_url', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({
      repo_type: 'local',
    });
    delete (data as any).remote_url;
    await repo.create(data);

    const updated = await repo.update(data.repo_id, { name: 'Updated Local' });

    expect(updated.name).toBe('Updated Local');
    expect(updated.repo_type).toBe('local');
    expect(updated.remote_url).toBeUndefined();
  });

  dbTest('should update environment_config', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    const updated = await repo.update(data.repo_id, {
      environment_config: {
        up_command: 'npm start',
        down_command: 'npm stop',
      },
    });

    expect(updated.environment_config).toEqual({
      up_command: 'npm start',
      down_command: 'npm stop',
    });
  });

  dbTest('should update last_updated timestamp', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    const created = await repo.create(data);

    // Wait a bit to ensure timestamp differs
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await repo.update(data.repo_id, { name: 'Updated' });

    expect(new Date(updated.last_updated).getTime()).toBeGreaterThan(
      new Date(created.last_updated).getTime()
    );
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new RepoRepository(db);

    await expect(repo.update('99999999', { name: 'Updated' })).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should throw for invalid update (missing remote_url)', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    await expect(repo.update(data.repo_id, { remote_url: '' })).rejects.toThrow(
      /Remote repos must have a remote_url/
    );
  });

  dbTest('should preserve unchanged fields', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({
      slug: 'my-repo',
      name: 'My Repo',
      remote_url: 'https://github.com/test/repo.git',
      default_branch: 'main',
    });
    const created = await repo.create(data);

    const updated = await repo.update(data.repo_id, { name: 'New Name' });

    expect(updated.slug).toBe(created.slug);
    expect(updated.remote_url).toBe(created.remote_url);
    expect(updated.default_branch).toBe(created.default_branch);
    expect(updated.local_path).toBe(created.local_path);
  });
});

// ============================================================================
// setEnvironment
// ============================================================================

describe('RepoRepository.setEnvironment', () => {
  dbTest('should replace environment wholesale, clearing renamed variants', async ({ db }) => {
    // Reproduces the .agor.yml import bug: user renames a variant in the
    // YAML file, re-imports, and the old variant key must NOT linger in the
    // DB. With deepMerge-based update() it did linger — setEnvironment
    // replaces wholesale.
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    // Initial state: two variants, "default" and "with-manager"
    await repo.setEnvironment(data.repo_id, {
      version: 2,
      default: 'with-manager',
      variants: {
        default: { start: 'echo d-start', stop: 'echo d-stop' },
        'with-manager': { start: 'echo wm-start-v1', stop: 'echo wm-stop' },
      },
    });

    // User renames "with-manager" → "without-manager" (different key), also
    // points default at the unified variant
    const renamed = await repo.setEnvironment(data.repo_id, {
      version: 2,
      default: 'default',
      variants: {
        default: { start: 'echo d-start-v2', stop: 'echo d-stop-v2' },
        'without-manager': { start: 'echo wom-start', stop: 'echo wom-stop' },
      },
    });

    expect(Object.keys(renamed.environment!.variants).sort()).toEqual([
      'default',
      'without-manager',
    ]);
    expect(renamed.environment!.variants['with-manager']).toBeUndefined();
    expect(renamed.environment!.variants.default.start).toBe('echo d-start-v2');
  });

  dbTest('should drop fields removed from a still-present variant', async ({ db }) => {
    // Secondary symptom of the same merge bug: removing a field from a
    // variant in .agor.yml should clear it from the DB.
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    await repo.setEnvironment(data.repo_id, {
      version: 2,
      default: 'default',
      variants: {
        default: {
          start: 'echo start',
          stop: 'echo stop',
          nuke: 'echo nuke',
          logs: 'echo logs',
        },
      },
    });

    // User edits yaml, removes `nuke` and `logs`
    const after = await repo.setEnvironment(data.repo_id, {
      version: 2,
      default: 'default',
      variants: {
        default: { start: 'echo start', stop: 'echo stop' },
      },
    });

    expect(after.environment!.variants.default.nuke).toBeUndefined();
    expect(after.environment!.variants.default.logs).toBeUndefined();
  });

  dbTest('should preserve unrelated columns (name, slug, local_path)', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ name: 'My Repo', slug: 'my-repo' });
    await repo.create(data);

    const updated = await repo.setEnvironment(data.repo_id, {
      version: 2,
      default: 'default',
      variants: { default: { start: 'echo s', stop: 'echo p' } },
    });

    expect(updated.name).toBe('My Repo');
    expect(updated.slug).toBe('my-repo');
    expect(updated.local_path).toBe(data.local_path);
    expect(updated.remote_url).toBe(data.remote_url);
  });

  dbTest('should clear environment when passed null', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    await repo.setEnvironment(data.repo_id, {
      version: 2,
      default: 'default',
      variants: { default: { start: 'echo s', stop: 'echo p' } },
    });

    const cleared = await repo.setEnvironment(data.repo_id, null);
    expect(cleared.environment).toBeUndefined();
  });

  dbTest('should re-derive the v1 environment_config projection', async ({ db }) => {
    // rowToRepo derives environment_config from v2. Make sure setEnvironment
    // keeps that projection in sync instead of leaving a stale v1 view.
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    const v1 = await repo.setEnvironment(data.repo_id, {
      version: 2,
      default: 'default',
      variants: {
        default: { start: 'echo up-1', stop: 'echo down-1' },
      },
    });
    expect(v1.environment_config?.up_command).toBe('echo up-1');

    const v2 = await repo.setEnvironment(data.repo_id, {
      version: 2,
      default: 'default',
      variants: {
        default: { start: 'echo up-2', stop: 'echo down-2' },
      },
    });
    expect(v2.environment_config?.up_command).toBe('echo up-2');
    expect(v2.environment_config?.down_command).toBe('echo down-2');
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new RepoRepository(db);
    await expect(
      repo.setEnvironment('99999999', {
        version: 2,
        default: 'default',
        variants: { default: { start: 'echo s', stop: 'echo p' } },
      })
    ).rejects.toThrow(EntityNotFoundError);
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('RepoRepository.delete', () => {
  dbTest('should delete repo by full UUID', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    await repo.delete(data.repo_id);

    const found = await repo.findById(data.repo_id);
    expect(found).toBeNull();
  });

  dbTest('should delete repo by short ID', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    const shortId = data.repo_id.replace(/-/g, '').slice(0, 8);
    await repo.delete(shortId);

    const found = await repo.findById(data.repo_id);
    expect(found).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new RepoRepository(db);

    await expect(repo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should not affect other repos', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data1 = createRepoData({ slug: 'repo-1' });
    const data2 = createRepoData({ slug: 'repo-2' });
    await repo.create(data1);
    await repo.create(data2);

    await repo.delete(data1.repo_id);

    const remaining = await repo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].slug).toBe('repo-2');
  });

  dbTest('should allow deleting by ambiguous short ID if resolved first', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    await repo.create(data);

    // Use full ID to avoid ambiguity
    await repo.delete(data.repo_id);

    const found = await repo.findById(data.repo_id);
    expect(found).toBeNull();
  });
});

// ============================================================================
// Count
// ============================================================================

describe('RepoRepository.count', () => {
  dbTest('should return 0 for empty database', async ({ db }) => {
    const repo = new RepoRepository(db);

    const count = await repo.count();

    expect(count).toBe(0);
  });

  dbTest('should return correct count', async ({ db }) => {
    const repo = new RepoRepository(db);

    await repo.create(createRepoData({ slug: 'repo-1' }));
    await repo.create(createRepoData({ slug: 'repo-2' }));
    await repo.create(createRepoData({ slug: 'repo-3' }));

    const count = await repo.count();

    expect(count).toBe(3);
  });

  dbTest('should update count after delete', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data1 = createRepoData({ slug: 'repo-1' });
    const data2 = createRepoData({ slug: 'repo-2' });

    await repo.create(data1);
    await repo.create(data2);
    expect(await repo.count()).toBe(2);

    await repo.delete(data1.repo_id);
    expect(await repo.count()).toBe(1);
  });
});

// ============================================================================
// Deprecated Methods
// ============================================================================

describe('RepoRepository deprecated methods', () => {
  dbTest('should throw error for addWorktree (deprecated)', async ({ db }) => {
    const repo = new RepoRepository(db);

    await expect((repo as any).addWorktree()).rejects.toThrow('deprecated');
    await expect((repo as any).addWorktree()).rejects.toThrow('WorktreeRepository');
  });

  dbTest('should throw error for removeWorktree (deprecated)', async ({ db }) => {
    const repo = new RepoRepository(db);

    await expect((repo as any).removeWorktree()).rejects.toThrow('deprecated');
    await expect((repo as any).removeWorktree()).rejects.toThrow('WorktreeRepository');
  });
});

// ============================================================================
// Slug Uniqueness
// ============================================================================

describe('RepoRepository slug uniqueness', () => {
  dbTest('should enforce unique slugs', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ slug: 'duplicate-slug' });

    await repo.create(data);

    // Attempt to create another repo with same slug
    const data2 = createRepoData({ slug: 'duplicate-slug' });

    await expect(repo.create(data2)).rejects.toThrow();
  });

  dbTest('should allow same slug after deletion', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data1 = createRepoData({ slug: 'reusable-slug' });

    const created1 = await repo.create(data1);
    await repo.delete(created1.repo_id);

    // Should now be able to create a new repo with same slug
    const data2 = createRepoData({ slug: 'reusable-slug' });
    const created2 = await repo.create(data2);

    expect(created2.slug).toBe('reusable-slug');
    expect(created2.repo_id).not.toBe(created1.repo_id);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('RepoRepository edge cases', () => {
  dbTest('should reject empty local_path', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ local_path: '' });

    // local_path is required — the repository rejects falsy values.
    await expect(repo.create(data)).rejects.toThrow(/local_path/);
  });

  dbTest('should handle undefined default_branch', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData();
    delete (data as any).default_branch;

    const created = await repo.create(data);

    expect(created.default_branch).toBeUndefined();
  });

  dbTest('should handle special characters in slug', async ({ db }) => {
    const repo = new RepoRepository(db);
    const data = createRepoData({ slug: 'test-repo_123' });

    const created = await repo.create(data);

    expect(created.slug).toBe('test-repo_123');
  });

  dbTest('should handle long URLs', async ({ db }) => {
    const repo = new RepoRepository(db);
    const longUrl =
      'https://github.com/very-long-organization-name/very-long-repository-name-with-many-words.git';
    const data = createRepoData({ remote_url: longUrl });

    const created = await repo.create(data);

    expect(created.remote_url).toBe(longUrl);
  });

  dbTest('should handle SSH URLs', async ({ db }) => {
    const repo = new RepoRepository(db);
    const sshUrl = 'git@github.com:user/repo.git';
    const data = createRepoData({ remote_url: sshUrl });

    const created = await repo.create(data);

    expect(created.remote_url).toBe(sshUrl);
  });
});
