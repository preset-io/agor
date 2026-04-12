/**
 * Zod validation schemas for the `resources:` section of config.yml.
 *
 * Validates structure, formats, and cross-references between declared resources.
 */

import { z } from 'zod';
import { REPO_SLUG_PATTERN } from './repo-reference';

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Must be a valid UUID');

/** Repo slug in org/name format — uses shared REPO_SLUG_PATTERN from repo-reference.ts */
const repoSlugSchema = z
  .string()
  .regex(
    REPO_SLUG_PATTERN,
    'Must be org/name format with alphanumeric, hyphens, underscores, or dots (e.g., "my-org/my-repo")'
  );

// ---------------------------------------------------------------------------
// EnforcedAgentConfig
// ---------------------------------------------------------------------------

export const enforcedAgentConfigSchema = z.object({
  agentic_tool: z.enum(['claude-code', 'codex', 'gemini', 'opencode', 'copilot']).optional(),
  permission_mode: z.string().optional(),
  model: z.string().optional(),
  mcp_server_ids: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// ResourceRepoConfig
// ---------------------------------------------------------------------------

export const resourceRepoConfigSchema = z
  .object({
    repo_id: uuidSchema,
    slug: repoSlugSchema,
    remote_url: z.string().optional(),
    repo_type: z.enum(['remote', 'local']).default('remote'),
    default_branch: z.string().optional(),
    shallow: z.boolean().optional(),
  })
  .refine((data) => data.repo_type !== 'remote' || data.remote_url, {
    message: 'remote_url is required when repo_type is "remote"',
    path: ['remote_url'],
  });

// ---------------------------------------------------------------------------
// ResourceWorktreeConfig
// ---------------------------------------------------------------------------

export const resourceWorktreeConfigSchema = z.object({
  worktree_id: uuidSchema,
  name: z.string().min(1, 'Worktree name is required'),
  ref: z.string().min(1, 'Git ref is required'),
  ref_type: z.enum(['branch', 'tag']).optional(),
  others_can: z.enum(['none', 'view', 'session', 'prompt', 'all']).optional(),
  mcp_server_ids: z.array(z.string()).optional(),
  repo: repoSlugSchema,
  readonly: z.boolean().optional(),
  agent: enforcedAgentConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// ResourceUserConfig
// ---------------------------------------------------------------------------

export const resourceUserConfigSchema = z.object({
  user_id: uuidSchema,
  email: z.string().email('Must be a valid email address'),
  name: z.string().optional(),
  role: z.enum(['superadmin', 'admin', 'member', 'viewer']).default('member'),
  unix_username: z.string().optional(),
  password: z.string().optional(),
});

// ---------------------------------------------------------------------------
// DaemonResourcesConfig (top-level)
// ---------------------------------------------------------------------------

export const daemonResourcesConfigSchema = z.object({
  repos: z.array(resourceRepoConfigSchema).optional(),
  worktrees: z.array(resourceWorktreeConfigSchema).optional(),
  users: z.array(resourceUserConfigSchema).optional(),
});

// ---------------------------------------------------------------------------
// Inferred types (for consumers that don't import zod)
// ---------------------------------------------------------------------------

export type ParsedRepoConfig = z.infer<typeof resourceRepoConfigSchema>;
export type ParsedWorktreeConfig = z.infer<typeof resourceWorktreeConfigSchema>;
export type ParsedUserConfig = z.infer<typeof resourceUserConfigSchema>;
export type ParsedResourcesConfig = z.infer<typeof daemonResourcesConfigSchema>;

// ---------------------------------------------------------------------------
// Cross-reference & uniqueness validation
// ---------------------------------------------------------------------------

export interface ResourceValidationError {
  path: string;
  message: string;
}

/**
 * Validate cross-references and uniqueness constraints that Zod can't express:
 * - No duplicate repo_id / worktree_id / user_id values
 * - No duplicate repo slugs
 * - worktree.repo references a declared repo slug
 */
export function validateResourceCrossReferences(
  resources: z.infer<typeof daemonResourcesConfigSchema>
): ResourceValidationError[] {
  const errors: ResourceValidationError[] = [];
  const repos = resources.repos ?? [];
  const worktrees = resources.worktrees ?? [];
  const users = resources.users ?? [];

  // Collect repo slugs for cross-reference checking
  const repoSlugs = new Set<string>();
  const repoIds = new Set<string>();

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];

    if (repoIds.has(repo.repo_id)) {
      errors.push({
        path: `resources.repos[${i}].repo_id`,
        message: `Duplicate repo_id: ${repo.repo_id}`,
      });
    }
    repoIds.add(repo.repo_id);

    if (repoSlugs.has(repo.slug)) {
      errors.push({
        path: `resources.repos[${i}].slug`,
        message: `Duplicate repo slug: ${repo.slug}`,
      });
    }
    repoSlugs.add(repo.slug);
  }

  // Check worktree uniqueness and repo cross-references
  const worktreeIds = new Set<string>();

  for (let i = 0; i < worktrees.length; i++) {
    const wt = worktrees[i];

    if (worktreeIds.has(wt.worktree_id)) {
      errors.push({
        path: `resources.worktrees[${i}].worktree_id`,
        message: `Duplicate worktree_id: ${wt.worktree_id}`,
      });
    }
    worktreeIds.add(wt.worktree_id);

    if (!repoSlugs.has(wt.repo)) {
      errors.push({
        path: `resources.worktrees[${i}].repo`,
        message: `Worktree references unknown repo slug: "${wt.repo}". Declared repos: [${[...repoSlugs].join(', ')}]`,
      });
    }
  }

  // Check user uniqueness
  const userIds = new Set<string>();
  const userEmails = new Set<string>();

  for (let i = 0; i < users.length; i++) {
    const user = users[i];

    if (userIds.has(user.user_id)) {
      errors.push({
        path: `resources.users[${i}].user_id`,
        message: `Duplicate user_id: ${user.user_id}`,
      });
    }
    userIds.add(user.user_id);

    if (userEmails.has(user.email)) {
      errors.push({
        path: `resources.users[${i}].email`,
        message: `Duplicate user email: ${user.email}`,
      });
    }
    userEmails.add(user.email);
  }

  return errors;
}
