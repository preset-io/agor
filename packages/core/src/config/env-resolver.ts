import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { select } from '../db/database-wrapper';
import { decryptApiKey } from '../db/encryption';
import { users } from '../db/schema';
import type { UserID } from '../types';

/**
 * Resolve user environment variables (decrypted from database, no system env vars)
 */
export async function resolveUserEnvironment(
  userId: UserID,
  db: Database
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();

    if (row) {
      const data = row.data as { env_vars?: Record<string, string> };
      const encryptedVars = data.env_vars;

      if (encryptedVars) {
        for (const [key, encryptedValue] of Object.entries(encryptedVars)) {
          try {
            env[key] = decryptApiKey(encryptedValue);
          } catch (err) {
            console.error(`Failed to decrypt env var ${key} for user ${userId}:`, err);
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
