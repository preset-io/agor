/**
 * Tests for resource config Zod schemas and cross-reference validation
 */

import { describe, expect, it } from 'vitest';
import {
  daemonResourcesConfigSchema,
  resourceRepoConfigSchema,
  resourceUserConfigSchema,
  resourceWorktreeConfigSchema,
  validateResourceCrossReferences,
} from './resource-schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';
const VALID_UUID_2 = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a70';
const VALID_UUID_3 = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a71';

function validRepo(overrides: Record<string, unknown> = {}) {
  return {
    repo_id: VALID_UUID,
    slug: 'my-org/my-repo',
    remote_url: 'https://github.com/my-org/my-repo.git',
    ...overrides,
  };
}

function validWorktree(overrides: Record<string, unknown> = {}) {
  return {
    worktree_id: VALID_UUID_2,
    name: 'main',
    ref: 'main',
    repo: 'my-org/my-repo',
    ...overrides,
  };
}

function validUser(overrides: Record<string, unknown> = {}) {
  return {
    user_id: VALID_UUID_3,
    email: 'admin@example.com',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Repo schema
// ---------------------------------------------------------------------------

describe('resourceRepoConfigSchema', () => {
  it('accepts valid repo config', () => {
    const result = resourceRepoConfigSchema.safeParse(validRepo());
    expect(result.success).toBe(true);
  });

  it('accepts repo with all optional fields', () => {
    const result = resourceRepoConfigSchema.safeParse(
      validRepo({
        repo_type: 'local',
        default_branch: 'develop',
        shallow: true,
      })
    );
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID', () => {
    const result = resourceRepoConfigSchema.safeParse(validRepo({ repo_id: 'not-a-uuid' }));
    expect(result.success).toBe(false);
  });

  it('rejects slug without org/name format', () => {
    const result = resourceRepoConfigSchema.safeParse(validRepo({ slug: 'my-repo' }));
    expect(result.success).toBe(false);
  });

  it('accepts slug with uppercase, dots, and underscores', () => {
    const result = resourceRepoConfigSchema.safeParse(validRepo({ slug: 'My_Org/my.repo' }));
    expect(result.success).toBe(true);
  });

  it('defaults repo_type to remote', () => {
    const result = resourceRepoConfigSchema.parse(validRepo());
    expect(result.repo_type).toBe('remote');
  });

  it('rejects remote repo without remote_url', () => {
    const result = resourceRepoConfigSchema.safeParse(
      validRepo({ remote_url: undefined, repo_type: 'remote' })
    );
    expect(result.success).toBe(false);
  });

  it('accepts local repo without remote_url', () => {
    const result = resourceRepoConfigSchema.safeParse(
      validRepo({ remote_url: undefined, repo_type: 'local' })
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Worktree schema
// ---------------------------------------------------------------------------

describe('resourceWorktreeConfigSchema', () => {
  it('accepts valid worktree config', () => {
    const result = resourceWorktreeConfigSchema.safeParse(validWorktree());
    expect(result.success).toBe(true);
  });

  it('accepts worktree with agent config', () => {
    const result = resourceWorktreeConfigSchema.safeParse(
      validWorktree({
        agent: {
          agentic_tool: 'claude-code',
          permission_mode: 'bypassPermissions',
          model: 'claude-sonnet-4-5-20250514',
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = resourceWorktreeConfigSchema.safeParse(validWorktree({ name: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects empty ref', () => {
    const result = resourceWorktreeConfigSchema.safeParse(validWorktree({ ref: '' }));
    expect(result.success).toBe(false);
  });

  it('accepts all permission levels', () => {
    for (const level of ['none', 'view', 'session', 'prompt', 'all']) {
      const result = resourceWorktreeConfigSchema.safeParse(validWorktree({ others_can: level }));
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// User schema
// ---------------------------------------------------------------------------

describe('resourceUserConfigSchema', () => {
  it('accepts valid user config', () => {
    const result = resourceUserConfigSchema.safeParse(validUser());
    expect(result.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const result = resourceUserConfigSchema.safeParse(validUser({ email: 'not-an-email' }));
    expect(result.success).toBe(false);
  });

  it('defaults role to member', () => {
    const result = resourceUserConfigSchema.parse(validUser());
    expect(result.role).toBe('member');
  });

  it('accepts all valid roles', () => {
    for (const role of ['superadmin', 'admin', 'member', 'viewer']) {
      const result = resourceUserConfigSchema.safeParse(validUser({ role }));
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Top-level resources schema
// ---------------------------------------------------------------------------

describe('daemonResourcesConfigSchema', () => {
  it('accepts empty resources', () => {
    const result = daemonResourcesConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts full resources config', () => {
    const result = daemonResourcesConfigSchema.safeParse({
      repos: [validRepo()],
      worktrees: [validWorktree()],
      users: [validUser()],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-reference validation
// ---------------------------------------------------------------------------

describe('validateResourceCrossReferences', () => {
  it('returns no errors for valid config', () => {
    const resources = daemonResourcesConfigSchema.parse({
      repos: [validRepo()],
      worktrees: [validWorktree()],
      users: [validUser()],
    });
    const errors = validateResourceCrossReferences(resources);
    expect(errors).toEqual([]);
  });

  it('detects duplicate repo IDs', () => {
    const resources = daemonResourcesConfigSchema.parse({
      repos: [validRepo(), validRepo({ slug: 'other-org/other-repo' })],
    });
    const errors = validateResourceCrossReferences(resources);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Duplicate repo_id');
  });

  it('detects duplicate repo slugs', () => {
    const resources = daemonResourcesConfigSchema.parse({
      repos: [validRepo(), validRepo({ repo_id: VALID_UUID_2 })],
    });
    const errors = validateResourceCrossReferences(resources);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Duplicate repo slug');
  });

  it('detects worktree referencing unknown repo', () => {
    const resources = daemonResourcesConfigSchema.parse({
      repos: [validRepo()],
      worktrees: [validWorktree({ repo: 'nonexistent/repo' })],
    });
    const errors = validateResourceCrossReferences(resources);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('unknown repo slug');
  });

  it('detects duplicate worktree IDs', () => {
    const resources = daemonResourcesConfigSchema.parse({
      repos: [validRepo()],
      worktrees: [validWorktree(), validWorktree({ name: 'develop' })],
    });
    const errors = validateResourceCrossReferences(resources);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Duplicate worktree_id');
  });

  it('detects duplicate user IDs', () => {
    const resources = daemonResourcesConfigSchema.parse({
      users: [validUser(), validUser({ email: 'other@example.com' })],
    });
    const errors = validateResourceCrossReferences(resources);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Duplicate user_id');
  });

  it('detects duplicate user emails', () => {
    const resources = daemonResourcesConfigSchema.parse({
      users: [validUser(), validUser({ user_id: VALID_UUID })],
    });
    const errors = validateResourceCrossReferences(resources);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Duplicate user email');
  });
});
