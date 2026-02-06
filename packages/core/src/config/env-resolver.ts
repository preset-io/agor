import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { select } from '../db/database-wrapper';
import { decryptApiKey } from '../db/encryption';
import { users } from '../db/schema';
import type { UserID } from '../types';

/**
 * Environment variables used internally by Agor daemon that should NOT be passed
 * to user processes (worktree environments, terminals, etc.)
 *
 * These variables control Agor daemon behavior and would interfere with
 * user applications if inherited (e.g., NODE_ENV='production' breaks dev servers).
 */
export const AGOR_INTERNAL_ENV_VARS = new Set([
  // Node.js environment control
  'NODE_ENV', // Agor daemon runs in production, but user apps should control this

  // Agor-specific variables
  'AGOR_USE_EXECUTOR', // Controls executor process spawning
  'AGOR_MASTER_SECRET', // Encryption key (also in blocklist, defense in depth)

  // Agor daemon ports
  'PORT', // Daemon port (user apps should use their own ports)
  'UI_PORT', // UI port (internal to Agor)
  'VITE_DAEMON_URL', // UI-to-daemon connection
  'VITE_DAEMON_PORT', // UI-to-daemon port

  // Deployment detection (used for security checks)
  'CODESPACES', // GitHub Codespaces detection
  'RAILWAY_ENVIRONMENT', // Railway deployment detection
  'RENDER', // Render deployment detection
]);

/**
 * Resolve user environment variables (decrypted from database, no system env vars)
 * Includes both env_vars and api_keys from user data
 */
export async function resolveUserEnvironment(
  userId: UserID,
  db: Database
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();

    if (row) {
      const data = row.data as {
        env_vars?: Record<string, string>;
        api_keys?: Record<string, string>;
      };

      // Decrypt and merge user environment variables (e.g., GITHUB_TOKEN)
      // Only override if the decrypted value is non-empty
      const encryptedVars = data.env_vars;
      if (encryptedVars) {
        for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
          try {
            const decryptedValue = decryptApiKey(encryptedValue);
            if (decryptedValue && decryptedValue.trim() !== '') {
              env[key] = decryptedValue;
            }
          } catch (err) {
            console.error(`Failed to decrypt env var ${key} for user ${userId}:`, err);
          }
        }
      }

      // Decrypt and merge user API keys (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY)
      // Only override if the decrypted value is non-empty
      const encryptedApiKeys = data.api_keys;
      if (encryptedApiKeys) {
        for (const [key, encryptedValue] of Object.entries(encryptedApiKeys)) {
          try {
            const decryptedValue = decryptApiKey(encryptedValue);
            if (decryptedValue && decryptedValue.trim() !== '') {
              env[key] = decryptedValue;
            }
          } catch (err) {
            console.error(`Failed to decrypt API key ${key} for user ${userId}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to resolve environment for user ${userId}:`, err);
  }

  return env;
}

/**
 * Synchronous version - returns system env only
 */
export function resolveSystemEnvironment(): Record<string, string> {
  return { ...process.env } as Record<string, string>;
}

/**
 * Special environment variable that contains comma-separated list of user-defined env var keys.
 * Used by MCP template resolver to restrict template context to user-scoped vars only.
 */
export const AGOR_USER_ENV_KEYS_VAR = 'AGOR_USER_ENV_KEYS';

/**
 * Create a clean environment for user processes (worktrees, terminals, etc.)
 *
 * This function:
 * 1. Starts with system environment (process.env)
 * 2. Filters out Agor-internal variables (NODE_ENV, AGOR_*, etc.)
 * 3. Optionally filters out user-identity vars (HOME/USER/LOGNAME/SHELL) for impersonation
 * 4. Resolves and merges user-specific encrypted environment variables
 * 5. Optionally merges additional environment variables
 * 6. Sets AGOR_USER_ENV_KEYS with comma-separated list of user-defined var keys
 *
 * @param userId - User ID to resolve environment for (optional)
 * @param db - Database instance (required if userId provided)
 * @param additionalEnv - Additional env vars to merge (optional, highest priority)
 * @param forImpersonation - If true, strips HOME/USER/LOGNAME/SHELL so sudo -u can set them (default: false)
 * @returns Clean environment object ready for child process spawning
 *
 * @example
 * // For worktree environment startup (with user)
 * const env = await createUserProcessEnvironment(worktree.created_by, db);
 * spawn(command, { cwd, shell: true, env });
 *
 * @example
 * // For user impersonation (strips HOME/USER/LOGNAME/SHELL)
 * const env = await createUserProcessEnvironment(worktree.created_by, db, undefined, true);
 * buildSpawnArgs(command, [], { asUser: 'alice', env });
 *
 * @example
 * // For worktree environment with custom NODE_ENV
 * const env = await createUserProcessEnvironment(worktree.created_by, db, {
 *   NODE_ENV: 'development',
 * });
 *
 * @example
 * // For daemon-spawned processes without user context
 * const env = await createUserProcessEnvironment();
 * spawn(command, { env });
 */
export async function createUserProcessEnvironment(
  userId?: UserID,
  db?: Database,
  additionalEnv?: Record<string, string>,
  forImpersonation = false
): Promise<Record<string, string>> {
  // Start with system environment
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  // Filter out Agor-internal variables
  for (const internalVar of AGOR_INTERNAL_ENV_VARS) {
    delete env[internalVar];
  }

  // For impersonation, also strip user-identity vars so sudo -u can set them
  // These are in AGOR_INTERNAL_ENV_VARS but we only want to filter them conditionally
  const USER_IDENTITY_VARS = ['HOME', 'USER', 'LOGNAME', 'SHELL'];
  if (forImpersonation) {
    for (const identityVar of USER_IDENTITY_VARS) {
      delete env[identityVar];
    }
  }

  // Track user-defined env var keys (for MCP template scoping)
  const userEnvKeys: string[] = [];

  // Resolve and merge user environment variables (if userId provided)
  // Only override if values are non-empty
  if (userId && db) {
    const userEnv = await resolveUserEnvironment(userId, db);
    for (const [key, value] of Object.entries(userEnv)) {
      if (value && value.trim() !== '') {
        env[key] = value;
        userEnvKeys.push(key);
      }
    }
  }

  // Merge additional environment variables (highest priority)
  // Only override if values are non-empty
  if (additionalEnv) {
    for (const [key, value] of Object.entries(additionalEnv)) {
      if (value && value.trim() !== '') {
        env[key] = value;
      }
    }
  }

  // Set AGOR_USER_ENV_KEYS to communicate user-defined var keys to child processes
  // This is used by MCP template resolver to restrict context to user-scoped vars only
  if (userEnvKeys.length > 0) {
    env[AGOR_USER_ENV_KEYS_VAR] = userEnvKeys.join(',');
  }

  return env;
}
