import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { select } from '../db/database-wrapper';
import { decryptApiKey } from '../db/encryption';
import { users } from '../db/schema';
import type { GatewayEnvVar, UserID } from '../types';
import { filterEnv } from './env-blocklist';

/**
 * SECURITY: Allowlisted environment variable names that are safe to pass
 * to user/agent processes. Any variable NOT in this list (or matching a
 * prefix below) will be stripped.
 *
 * This is an allowlist (not a blocklist) so that new sensitive variables
 * added to the daemon environment don't accidentally leak to sessions.
 */
export const ALLOWED_ENV_VARS = new Set([
  // Shell essentials
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'HOSTNAME',

  // Temp directories
  'TMPDIR',
  'TMP',
  'TEMP',

  // Locale
  'LANG',
  'LANGUAGE',

  // Terminal
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',

  // Editor
  'EDITOR',
  'VISUAL',

  // Display (for GUI tools)
  'DISPLAY',
  'WAYLAND_DISPLAY',

  // SSH (for git operations)
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',

  // GPG (for git signing)
  'GPG_AGENT_INFO',
  'GPG_TTY',

  // Proxy / TLS (needed for corporate environments)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',

  // Node.js (safe subset — NOT NODE_OPTIONS which could inject code)
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',

  // Git identity
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_SSH_COMMAND',

  // Anthropic / AI SDK — Edited by Claude
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',

  // Vertex AI (Claude Code on GCP)
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUD_ML_REGION',
  'CLOUD_ML_PROJECT_ID',

  // Bedrock (Claude Code on AWS)
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',

  // Agor session context (safe for executor/sessions)
  'DAEMON_URL',
]);

/**
 * Environment variable prefixes that are safe to pass through.
 * Any variable starting with one of these prefixes is allowed.
 */
export const ALLOWED_ENV_PREFIXES = [
  'LC_', // Locale settings (LC_ALL, LC_CTYPE, etc.)
  'XDG_', // Freedesktop directories (XDG_DATA_HOME, XDG_CONFIG_HOME, etc.)
  'CLAUDE_CODE_', // All Claude Code config vars (use_vertex, use_bedrock, etc.)
  'ANTHROPIC_', // All Anthropic SDK vars (catches future additions)
];

/**
 * @deprecated Use ALLOWED_ENV_VARS instead. Kept for backward compatibility
 * with any code that references this set. Will be removed in a future version.
 */
export const AGOR_INTERNAL_ENV_VARS = new Set([
  'NODE_ENV',
  'AGOR_USE_EXECUTOR',
  'AGOR_MASTER_SECRET',
  'PORT',
  'UI_PORT',
  'VITE_DAEMON_URL',
  'VITE_DAEMON_PORT',
  'CODESPACES',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
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

      // Decrypt and merge user API keys and base URLs (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL)
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

  // Strip process-hijacking env vars (NODE_OPTIONS, LD_PRELOAD, PYTHON*, etc.)
  // before returning, so callers who spawn subprocesses with this env cannot
  // be hijacked by an attacker who stored such a key in their user env.
  const { env: safeEnv, rejected } = filterEnv(env, (key) => {
    console.warn(`[resolveUserEnvironment] Rejected denied env key from user ${userId}: ${key}`);
  });
  if (rejected.length > 0) {
    console.warn(
      `[resolveUserEnvironment] Stripped ${rejected.length} denied env key(s) for user ${userId}`
    );
  }

  return safeEnv;
}

/**
 * Synchronous version - returns allowlisted system env only.
 * SECURITY: Does not return full process.env.
 */
export function resolveSystemEnvironment(): Record<string, string> {
  return buildAllowlistedEnv();
}

/**
 * Special environment variable that contains comma-separated list of user-defined env var keys.
 * Used by MCP template resolver to restrict template context to user-scoped vars only.
 */
export const AGOR_USER_ENV_KEYS_VAR = 'AGOR_USER_ENV_KEYS';

/**
 * Check if an environment variable name is allowed to be passed to child processes.
 */
function isAllowedEnvVar(key: string): boolean {
  if (ALLOWED_ENV_VARS.has(key)) return true;
  for (const prefix of ALLOWED_ENV_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Build a minimal environment from process.env using the allowlist.
 * Only copies variables that are explicitly allowed.
 */
function buildAllowlistedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isAllowedEnvVar(key)) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Create a clean environment for user processes (worktrees, terminals, etc.)
 *
 * SECURITY: Uses an allowlist approach — starts with an empty environment and
 * only copies variables that are explicitly safe. This prevents leaking internal
 * secrets (DATABASE_URL, AGOR_MASTER_SECRET, etc.) to agent sessions.
 *
 * This function:
 * 1. Starts with a minimal allowlisted subset of process.env
 * 2. Optionally strips user-identity vars (HOME/USER/LOGNAME/SHELL) for impersonation
 * 3. Resolves and merges user-specific encrypted environment variables from database
 * 4. Optionally merges additional environment variables
 * 5. Sets AGOR_USER_ENV_KEYS with comma-separated list of user-defined var keys
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
  forImpersonation = false,
  /**
   * Gateway-level env vars (e.g., service account tokens).
   *
   * - Fallback vars (`forceOverride: false`) are merged BEFORE user env vars — user values win.
   * - Force-override vars (`forceOverride: true`) are merged AFTER user env vars — channel values win.
   * - All gateway keys are included in AGOR_USER_ENV_KEYS for MCP template resolution.
   */
  gatewayEnv?: GatewayEnvVar[]
): Promise<Record<string, string>> {
  // SECURITY: Start with allowlisted env vars only — never inherit full process.env
  const env = buildAllowlistedEnv();

  // For impersonation, strip user-identity vars so sudo -u can set them
  const USER_IDENTITY_VARS = ['HOME', 'USER', 'LOGNAME', 'SHELL'];
  if (forImpersonation) {
    for (const identityVar of USER_IDENTITY_VARS) {
      delete env[identityVar];
    }
  }

  // Track user-defined env var keys (for MCP template scoping)
  const userEnvKeys: string[] = [];

  // Split gateway env vars by override mode
  const gatewayFallback = gatewayEnv?.filter((v) => !v.forceOverride) ?? [];
  const gatewayForceOverride = gatewayEnv?.filter((v) => v.forceOverride) ?? [];

  // 1. Merge gateway fallback vars (low priority — user vars override these)
  for (const { key, value } of gatewayFallback) {
    if (value && value.trim() !== '') {
      env[key] = value;
      userEnvKeys.push(key);
    }
  }

  // 2. Resolve and merge user environment variables (if userId provided)
  // Only override if values are non-empty — takes precedence over gateway fallback vars
  if (userId && db) {
    const userEnv = await resolveUserEnvironment(userId, db);
    for (const [key, value] of Object.entries(userEnv)) {
      if (value && value.trim() !== '') {
        env[key] = value;
        if (!userEnvKeys.includes(key)) {
          userEnvKeys.push(key);
        }
      }
    }
  }

  // 3. Merge gateway force-override vars (takes precedence over user vars)
  for (const { key, value } of gatewayForceOverride) {
    if (value && value.trim() !== '') {
      env[key] = value;
      if (!userEnvKeys.includes(key)) {
        userEnvKeys.push(key);
      }
    }
  }

  // 4. Merge additional environment variables (highest priority)
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
