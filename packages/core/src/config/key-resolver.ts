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
 * Result of API key resolution
 */
export interface KeyResolutionResult {
  /** Resolved API key, or undefined if not found at any level */
  apiKey: string | undefined;
  /** Source where the key was found */
  source: 'user' | 'config' | 'env' | 'none';
  /** Whether SDK should fall back to native auth (OAuth, CLI login, etc.) */
  useNativeAuth: boolean;
}

/**
 * Resolve API key with precedence:
 * 1. Per-user key (if user authenticated and key set in database) - HIGHEST
 * 2. Global config.yaml - MEDIUM
 * 3. Environment variables - LOW
 * 4. SDK native auth (OAuth, CLI login) - FALLBACK (useNativeAuth=true)
 *
 * @param keyName - Name of the API key to resolve
 * @param context - Resolution context (user ID and database)
 * @returns Resolution result with key, source, and native auth flag
 */
export async function resolveApiKey(
  keyName: ApiKeyName,
  context: KeyResolutionContext = {}
): Promise<KeyResolutionResult> {
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
            return { apiKey: decryptedKey, source: 'user', useNativeAuth: false };
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
    return { apiKey: globalKey, source: 'config', useNativeAuth: false };
  } else {
    console.log(`   ✗ No app-level API key for ${keyName}`);
  }

  // 3. Check environment variable (third precedence)
  console.log(`   → Checking OS-level environment variables...`);
  const envKey = process.env[keyName];
  if (envKey && envKey.length > 0) {
    console.log(`   ✓ Found OS-level environment variable ${keyName}`);
    return { apiKey: envKey, source: 'env', useNativeAuth: false };
  } else {
    console.log(`   ✗ No OS-level environment variable ${keyName}`);
  }

  // 4. No key found - SDK should fall back to native auth (OAuth, CLI login, etc.)
  console.log(`   ℹ️  No API key found for ${keyName} - SDK will use native authentication`);
  return { apiKey: undefined, source: 'none', useNativeAuth: true };
}

/**
 * Synchronous version of resolveApiKey (only checks config + env, not per-user)
 * Use this when database access is not available
 *
 * @param keyName - Name of the API key to resolve
 * @returns Resolution result (cannot check user-level keys synchronously)
 */
export function resolveApiKeySync(keyName: ApiKeyName): KeyResolutionResult {
  // Check global config.yaml
  const globalKey = getCredential(keyName);
  if (globalKey && globalKey.length > 0) {
    return { apiKey: globalKey, source: 'config', useNativeAuth: false };
  }

  // Check environment variable
  const envKey = process.env[keyName];
  if (envKey && envKey.length > 0) {
    return { apiKey: envKey, source: 'env', useNativeAuth: false };
  }

  // No key found - use native auth
  return { apiKey: undefined, source: 'none', useNativeAuth: true };
}

/**
 * Resolve API base URL with precedence:
 * 1. Per-user base URL (if user authenticated and set in database) - HIGHEST
 * 2. Global config.yaml - MEDIUM
 * 3. Environment variables - LOW
 * 4. SDK default (undefined, SDK uses its default) - FALLBACK
 *
 * @param baseUrlKey - Name of the base URL to resolve (e.g., 'ANTHROPIC_BASE_URL')
 * @param context - Resolution context (user ID and database)
 * @returns Resolved base URL or undefined (SDK will use default)
 */
export async function resolveBaseUrl(
  baseUrlKey: string,
  context: KeyResolutionContext = {}
): Promise<string | undefined> {
  console.log(
    `🔍 [Base URL Resolution] Resolving ${baseUrlKey} for user ${context.userId?.substring(0, 8) || 'none'}`
  );

  // 1. Check per-user base URL (highest precedence)
  if (context.userId && context.db) {
    console.log(`   → Checking user-level configuration...`);
    try {
      const row = await select(context.db)
        .from(users)
        .where(eq(users.user_id, context.userId))
        .one();

      if (row) {
        const data = row.data as { api_keys?: Record<string, string> };
        const encryptedUrl = data.api_keys?.[baseUrlKey];

        if (encryptedUrl) {
          const decryptedUrl = decryptApiKey(encryptedUrl);
          if (decryptedUrl && decryptedUrl.length > 0) {
            console.log(
              `   ✓ Found user-level base URL for ${baseUrlKey} (user: ${context.userId.substring(0, 8)})`
            );
            return decryptedUrl;
          } else {
            console.log(
              `   ✗ User-level base URL for ${baseUrlKey} is empty (user: ${context.userId.substring(0, 8)})`
            );
          }
        } else {
          console.log(`   ✗ No user-level base URL for ${baseUrlKey}`);
        }
      } else {
        console.log(`   ✗ User record not found`);
      }
    } catch (err) {
      console.error(`   ✗ Failed to check user-level base URL:`, err);
      // Fall through to global/env fallback
    }
  } else if (!context.userId) {
    console.log(`   → Skipping user-level check (no user ID provided)`);
  } else if (!context.db) {
    console.log(`   → Skipping user-level check (no database connection)`);
  }

  // 2. Check global config.yaml (second precedence)
  console.log(`   → Checking app-level configuration (config.yaml)...`);
  const globalUrl = getCredential(baseUrlKey as 'ANTHROPIC_BASE_URL');
  if (globalUrl && globalUrl.length > 0) {
    console.log(`   ✓ Found app-level base URL for ${baseUrlKey} (from config.yaml)`);
    return globalUrl;
  } else {
    console.log(`   ✗ No app-level base URL for ${baseUrlKey}`);
  }

  // 3. Check environment variable (third precedence)
  console.log(`   → Checking OS-level environment variables...`);
  const envUrl = process.env[baseUrlKey];
  if (envUrl && envUrl.length > 0) {
    console.log(`   ✓ Found OS-level environment variable ${baseUrlKey}`);
    return envUrl;
  } else {
    console.log(`   ✗ No OS-level environment variable ${baseUrlKey}`);
  }

  // 4. No base URL found - SDK will use its default
  console.log(`   ℹ️  No base URL found for ${baseUrlKey} - SDK will use default endpoint`);
  return undefined;
}

/**
 * Synchronous version of resolveBaseUrl (only checks config + env, not per-user)
 * Use this when database access is not available
 *
 * @param baseUrlKey - Name of the base URL to resolve
 * @returns Resolved base URL or undefined (SDK will use default)
 */
export function resolveBaseUrlSync(baseUrlKey: string): string | undefined {
  // Check global config.yaml
  const globalUrl = getCredential(baseUrlKey as 'ANTHROPIC_BASE_URL');
  if (globalUrl && globalUrl.length > 0) {
    return globalUrl;
  }

  // Check environment variable
  const envUrl = process.env[baseUrlKey];
  if (envUrl && envUrl.length > 0) {
    return envUrl;
  }

  // No base URL found - use SDK default
  return undefined;
}
