/**
 * Repo Reference Parser
 *
 * Handles parsing and resolution of repo references in three formats:
 * 1. Absolute path: /Users/max/code/agor
 * 2. Agor-managed slug: anthropics/agor
 * 3. Slug + worktree: anthropics/agor:feat-auth
 */

import type { RepoSlug, UUID, WorktreeName } from '../types';

/**
 * Parsed repo reference
 */
export interface RepoReference {
  /** Reference type */
  type: 'path' | 'managed' | 'managed-worktree';

  /** Absolute path (for type='path') */
  path?: string;

  /** Repository slug (for type='managed' or 'managed-worktree') */
  slug?: RepoSlug;

  /** Worktree name (for type='managed-worktree') */
  worktree?: WorktreeName;
}

/**
 * Parse a repo reference string
 *
 * @param ref - Repo reference (path | slug | slug:worktree)
 * @returns Parsed reference
 *
 * @example
 * parseRepoReference('/Users/max/code/agor')
 * // => { type: 'path', path: '/Users/max/code/agor' }
 *
 * @example
 * parseRepoReference('anthropics/agor')
 * // => { type: 'managed', slug: 'anthropics/agor' }
 *
 * @example
 * parseRepoReference('anthropics/agor:main')
 * // => { type: 'managed-worktree', slug: 'anthropics/agor', worktree: 'main' }
 */
export function parseRepoReference(ref: string): RepoReference {
  // Check if it's an absolute path
  if (ref.startsWith('/') || /^[A-Z]:\\/.test(ref)) {
    return { type: 'path', path: ref };
  }

  // Check for worktree separator
  if (ref.includes(':')) {
    const [slug, worktree] = ref.split(':', 2);
    return { type: 'managed-worktree', slug: slug as RepoSlug, worktree: worktree as WorktreeName };
  }

  // Plain slug (Agor-managed)
  return { type: 'managed', slug: ref as RepoSlug };
}

/**
 * Extract slug from git URL
 *
 * @param url - Git remote URL
 * @returns Repository slug (org/name)
 *
 * @example
 * extractSlugFromUrl('https://github.com/preset-io/agor.git')
 * // => 'preset-io/agor'
 *
 * @example
 * extractSlugFromUrl('git@github.com:apache/superset.git')
 * // => 'apache/superset'
 */
export function extractSlugFromUrl(url: string): RepoSlug {
  // Remove .git suffix if present
  const cleanUrl = url.endsWith('.git') ? url.slice(0, -4) : url;

  // Handle SSH format: git@github.com:org/repo
  if (cleanUrl.includes('@')) {
    const match = cleanUrl.match(/:([^/]+\/[^/]+)$/);
    if (match) {
      return match[1] as RepoSlug;
    }
  }

  // Handle HTTPS format: https://github.com/org/repo
  const match = cleanUrl.match(/[:/]([^/]+\/[^/]+)$/);
  if (match) {
    return match[1] as RepoSlug;
  }

  // Fallback: use last two path segments
  const segments = cleanUrl.split('/').filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}` as RepoSlug;
  }

  throw new Error(`Could not extract slug from URL: ${url}`);
}

/**
 * Validate slug format (org/name)
 *
 * @param slug - Repository slug to validate
 * @returns True if valid
 */
export function isValidSlug(slug: string): boolean {
  // Must be org/name format with valid characters (matching GitHub's naming rules)
  // - Supports: alphanumeric, hyphens, underscores, and dots
  // - Safe for use in filesystem paths
  const slugPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
  return slugPattern.test(slug);
}

/**
 * Validate git URL format
 *
 * @param url - Git URL to validate
 * @returns True if valid git URL
 *
 * @example
 * isValidGitUrl('git@github.com:apache/superset.git') // => true
 * isValidGitUrl('https://github.com/apache/superset.git') // => true
 * isValidGitUrl('https://github.com/apache/superset') // => true (page URL is valid)
 */
export function isValidGitUrl(url: string): boolean {
  // SSH format: git@host:path or ssh://git@host/path
  const sshPattern = /^(ssh:\/\/)?git@[\w.-]+(:\d+)?[:/][\w./-]+$/;

  // HTTP(S) format: https://host/path
  const httpsPattern = /^https?:\/\/[\w.-]+(:\d+)?\/[\w./-]+$/;

  return sshPattern.test(url) || httpsPattern.test(url);
}

/**
 * Resolve repo reference to SessionRepoContext
 *
 * Note: This function requires database access and should be called from
 * CLI commands or services that have access to the database instance.
 * The actual implementation is in the CLI/daemon layer.
 *
 * @param ref - Repo reference string
 * @returns Promise resolving to SessionRepoContext
 *
 * @throws Error if repo not found or path doesn't exist
 *
 * @example
 * // In CLI command with database access:
 * const context = await resolveRepoReference('anthropics/agor:main', db);
 */
export async function resolveRepoReference(ref: string): Promise<{
  repo_id?: UUID;
  repo_slug?: RepoSlug;
  worktree_name?: WorktreeName;
  cwd: string;
  managed_worktree: boolean;
}> {
  // Parse the reference
  const parsed = parseRepoReference(ref);

  if (parsed.type === 'path') {
    // User-managed repo - use path directly
    return {
      cwd: parsed.path as string,
      managed_worktree: false,
    };
  }

  // For managed repos, caller must implement database lookup
  // This is a stub that will be replaced with actual implementation in CLI/daemon
  throw new Error(
    `Repository lookup not implemented in this context. ` +
      `Parsed reference: ${JSON.stringify(parsed)}`
  );
}

/**
 * Format repo reference for display
 *
 * @param slug - Repository slug
 * @param worktreeName - Optional worktree name
 * @returns Formatted reference string
 *
 * @example
 * formatRepoReference('anthropics/agor', 'main')
 * // => 'anthropics/agor:main'
 *
 * @example
 * formatRepoReference('anthropics/agor')
 * // => 'anthropics/agor'
 */
export function formatRepoReference(slug: RepoSlug, worktreeName?: WorktreeName): string {
  if (worktreeName) {
    return `${slug}:${worktreeName}`;
  }
  return slug;
}
