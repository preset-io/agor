/**
 * Pure sync logic for config resource declarations.
 *
 * These functions determine what actions to take without performing side effects.
 * This makes them trivially unit-testable.
 *
 * Function signatures use structural types (not branded) so they accept both
 * canonical types (Repo, Worktree, User) and Zod-parsed plain objects.
 */

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type RepoAction = 'create' | 'update' | 'unchanged';
export type WorktreeAction = 'create' | 'update' | 'unchanged';
export type UserAction = 'create' | 'update' | 'unchanged';

// ---------------------------------------------------------------------------
// Repo sync decisions
// ---------------------------------------------------------------------------

export function determineRepoAction(
  config: { remote_url?: string; default_branch?: string },
  existing: { remote_url?: string; default_branch?: string } | null
): RepoAction {
  if (!existing) return 'create';

  const needsUpdate =
    (config.remote_url !== undefined && existing.remote_url !== config.remote_url) ||
    (config.default_branch !== undefined && existing.default_branch !== config.default_branch);

  return needsUpdate ? 'update' : 'unchanged';
}

// ---------------------------------------------------------------------------
// Worktree sync decisions
// ---------------------------------------------------------------------------

export function determineWorktreeAction(
  config: { ref: string; others_can?: string; mcp_server_ids?: string[] },
  existing: { ref: string; others_can?: string; mcp_server_ids?: string[] } | null
): WorktreeAction {
  if (!existing) return 'create';

  const needsUpdate =
    existing.ref !== config.ref ||
    (config.others_can !== undefined && existing.others_can !== config.others_can) ||
    (config.mcp_server_ids !== undefined &&
      JSON.stringify(existing.mcp_server_ids) !== JSON.stringify(config.mcp_server_ids));

  return needsUpdate ? 'update' : 'unchanged';
}

// ---------------------------------------------------------------------------
// User sync decisions
// ---------------------------------------------------------------------------

export function determineUserAction(
  config: { name?: string; role?: string; unix_username?: string },
  existing: { name?: string; role?: string; unix_username?: string } | null
): UserAction {
  if (!existing) return 'create';

  const needsUpdate =
    (config.name !== undefined && existing.name !== config.name) ||
    (config.role !== undefined && existing.role !== config.role) ||
    (config.unix_username !== undefined && existing.unix_username !== config.unix_username);

  return needsUpdate ? 'update' : 'unchanged';
}

// ---------------------------------------------------------------------------
// Password resolution
// ---------------------------------------------------------------------------

export interface ResolvedPassword {
  /** The cleartext password (before hashing) */
  password: string;
  /** Whether the user must change this password on first login */
  mustChange: boolean;
}

/**
 * Resolve a password config value to a cleartext password.
 *
 * Rules:
 * - If omitted/undefined: generate a random temporary password, mustChange=true
 * - If contains `{{`: treat as Handlebars template, resolve `{{env.VAR_NAME}}`
 * - Otherwise: use as literal string
 *
 * @throws Error if a Handlebars template references a missing env var
 */
export function resolvePassword(
  config: string | undefined,
  env: Record<string, string | undefined> = process.env
): ResolvedPassword {
  // No password configured — generate a temporary one
  if (config === undefined || config === '') {
    const generated = generateRandomPassword();
    return { password: generated, mustChange: true };
  }

  // Handlebars template — resolve {{env.VAR_NAME}}
  if (config.includes('{{')) {
    const resolved = resolveHandlebarsEnv(config, env);
    return { password: resolved, mustChange: false };
  }

  // Literal string
  return { password: config, mustChange: false };
}

/**
 * Resolve Handlebars-style `{{env.VAR_NAME}}` references in a string.
 *
 * @throws Error if any referenced env var is not set or if unrecognized templates remain
 */
function resolveHandlebarsEnv(template: string, env: Record<string, string | undefined>): string {
  const resolved = template.replace(/\{\{\s*env\.(\w+)\s*\}\}/g, (_match, varName: string) => {
    const value = env[varName];
    if (value === undefined || value === '') {
      throw new Error(
        `Environment variable ${varName} is not set (referenced in password template "${template}")`
      );
    }
    return value;
  });

  // Error on any unresolved templates (e.g. {{typo}}, {{unknown.ref}})
  const remaining = resolved.match(/\{\{[^}]*\}\}/);
  if (remaining) {
    throw new Error(
      `Unrecognized template expression ${remaining[0]} in password template "${template}". Only {{env.VAR_NAME}} is supported.`
    );
  }

  return resolved;
}

/**
 * Generate a random password (32 hex chars).
 */
function generateRandomPassword(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Slug → repo_id resolution
// ---------------------------------------------------------------------------

export function buildSlugToRepoIdMap(
  repos: Array<{ repo_id: string; slug: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const repo of repos) {
    map.set(repo.slug, repo.repo_id);
  }
  return map;
}
