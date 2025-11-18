import { decryptApiKey, eq } from '../db';
import type { Database } from '../db/client';
import { select } from '../db/database-wrapper';
import { users } from '../db/schema';
import type { UserID } from '../types';
import { getCredential } from './config-manager';

export type ApiKeyName = 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY';

export interface KeyResolutionContext {
  /** User ID for per-user key lookup */
  userId?: UserID;
  /** Database instance for user lookup */
  db?: Database;
}

/**
 * Resolve API key with precedence:
 * 1. Per-user key (if user authenticated and key set in database)
 * 2. Global config.yaml
 * 3. Environment variables
 *
 * @param keyName - Name of the API key to resolve
 * @param context - Resolution context (user ID and database)
 * @returns Decrypted API key or undefined if not found
 */
export async function resolveApiKey(
  keyName: ApiKeyName,
  context: KeyResolutionContext = {}
): Promise<string | undefined> {
  // 1. Check per-user key (highest precedence)
  if (context.userId && context.db) {
    try {
      const row = await select(context.db)
        .from(users)
        .where(eq(users.user_id, context.userId))
        .one();

      if (row) {
        const data = row.data as { api_keys?: Record<string, string> };
        const encryptedKey = data.api_keys?.[keyName];

        if (encryptedKey) {
          const decryptedKey = decryptApiKey(encryptedKey);
          console.log(
            `🔑 Using per-user API key for ${keyName} (user: ${context.userId.substring(0, 8)})`
          );
          return decryptedKey;
        }
      }
    } catch (err) {
      console.error(`Failed to resolve per-user key for ${keyName}:`, err);
      // Fall through to global/env fallback
    }
  }

  // 2. Check global config.yaml (second precedence)
  const globalKey = getCredential(keyName);
  if (globalKey) {
    console.log(`🔑 Using global API key for ${keyName} (from config.yaml)`);
    return globalKey;
  }

  // 3. Fallback to environment variable (lowest precedence)
  const envKey = process.env[keyName];
  if (envKey) {
    console.log(`🔑 Using environment variable for ${keyName}`);
    return envKey;
  }

  // No key found
  return undefined;
}

/**
 * Synchronous version of resolveApiKey (only checks global + env, not per-user)
 * Use this when database access is not available
 */
export function resolveApiKeySync(keyName: ApiKeyName): string | undefined {
  // Check global config.yaml
  const globalKey = getCredential(keyName);
  if (globalKey) return globalKey;

  // Fallback to environment variable
  return process.env[keyName];
}
