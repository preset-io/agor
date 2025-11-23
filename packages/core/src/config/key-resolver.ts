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
  console.log(
    `🔍 [API Key Resolution] Resolving ${keyName} for user ${context.userId?.substring(0, 8) || 'none'}`
  );

  // 1. Check per-user key (highest precedence)
  if (context.userId && context.db) {
    console.log(`   → Checking user-level configuration...`);
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
          if (decryptedKey && decryptedKey.length > 0) {
            console.log(
              `   ✓ Found user-level API key for ${keyName} (user: ${context.userId.substring(0, 8)})`
            );
            return decryptedKey;
          } else {
            console.log(
              `   ✗ User-level API key for ${keyName} is empty (user: ${context.userId.substring(0, 8)})`
            );
          }
        } else {
          console.log(`   ✗ No user-level API key for ${keyName}`);
        }
      } else {
        console.log(`   ✗ User record not found`);
      }
    } catch (err) {
      console.error(`   ✗ Failed to check user-level key:`, err);
      // Fall through to global/env fallback
    }
  } else if (!context.userId) {
    console.log(`   → Skipping user-level check (no user ID provided)`);
  } else if (!context.db) {
    console.log(`   → Skipping user-level check (no database connection)`);
  }

  // 2. Check global config.yaml (second precedence)
  console.log(`   → Checking app-level configuration (config.yaml)...`);
  const globalKey = getCredential(keyName);
  if (globalKey && globalKey.length > 0) {
    console.log(`   ✓ Found app-level API key for ${keyName} (from config.yaml)`);
    return globalKey;
  } else {
    console.log(`   ✗ No app-level API key for ${keyName}`);
  }

  // 3. Fallback to environment variable (lowest precedence)
  console.log(`   → Checking OS-level environment variables...`);
  const envKey = process.env[keyName];
  if (envKey && envKey.length > 0) {
    console.log(`   ✓ Found OS-level environment variable ${keyName}`);
    return envKey;
  } else {
    console.log(`   ✗ No OS-level environment variable ${keyName}`);
  }

  // No key found
  console.log(`   ❌ No API key found for ${keyName} at any level`);
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
