import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { decryptApiKey } from '../db/encryption';
import { users } from '../db/schema';
import type { UserID } from '../types';

/**
 * Resolve user-specific environment variables from database.
 *
 * Returns ONLY the user's explicit env vars (from database, encrypted).
 * Does NOT include system process.env - that's merged later in createGit().
 *
 * This separation is important because:
 * - User env vars should override system env vars
 * - We don't want Codespaces/CI system tokens polluting user env
 * - Merging happens in createGit(): { ...process.env, ...userEnv }
 *
 * @param userId - User ID to resolve environment for
 * @param db - Database instance
 * @returns User's environment variables only (decrypted from database)
 */
export async function resolveUserEnvironment(
  userId: UserID,
  db: Database
): Promise<Record<string, string>> {
  // Start with empty env - ONLY user's explicit vars
  const env: Record<string, string> = {};

  // Fetch user's encrypted env vars
  try {
    const row = await db.select().from(users).where(eq(users.user_id, userId)).get();

    if (row) {
      const data = row.data as { env_vars?: Record<string, string> };
      const encryptedVars = data.env_vars;

      if (encryptedVars) {
        for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
          try {
            // Decrypt and merge (user env vars override system)
            env[key] = decryptApiKey(encryptedValue);
          } catch (err) {
            console.error(`Failed to decrypt env var ${key} for user ${userId}:`, err);
            // Skip this variable (don't crash)
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to resolve environment for user ${userId}:`, err);
    // Fall back to system env only
  }

  return env;
}

/**
 * Synchronous version (for contexts where async not available)
 * Only returns system env (no per-user env vars)
 */
export function resolveSystemEnvironment(): Record<string, string> {
  return { ...process.env } as Record<string, string>;
}
