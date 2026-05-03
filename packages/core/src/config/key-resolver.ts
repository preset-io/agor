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
  /** True when a user-level key exists but couldn't be decrypted (master secret mismatch) */
  decryptionFailed?: boolean;
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

  // 1. Check per-user key (highest precedence). Storage moved from a flat
  //    `data.api_keys` namespace to `data.agentic_tools[toolName][envVarName]`,
  //    so we sweep every tool bucket looking for the requested keyName. The
  //    first non-empty match wins. This preserves the legacy "any user key for
  //    this name" semantic — a tool-scoped resolver is a follow-up; for now
  //    the executor spawn path (env-resolver) is the one that actually enforces
  //    per-SDK isolation.
  if (context.userId && context.db) {
    console.log(`   → Checking user-level configuration...`);
    const row = await select(context.db).from(users).where(eq(users.user_id, context.userId)).one();

    if (row) {
      const data = row.data as {
        agentic_tools?: Record<string, Record<string, string> | undefined>;
      };

      let encryptedKey: string | undefined;
      const tools = data.agentic_tools ?? {};
      for (const fields of Object.values(tools)) {
        if (fields?.[keyName]) {
          encryptedKey = fields[keyName];
          break;
        }
      }

      if (encryptedKey) {
        try {
          const decryptedKey = decryptApiKey(encryptedKey);
          if (decryptedKey && decryptedKey.length > 0) {
            console.log(
              `   ✓ Found user-level API key for ${keyName} (user: ${context.userId.substring(0, 8)})`
            );
            return { apiKey: decryptedKey, source: 'user', useNativeAuth: false };
          }
        } catch {
          // Key exists but can't be decrypted (master secret changed) — stop here, don't fall through
          return {
            apiKey: undefined,
            source: 'user',
            useNativeAuth: false,
            decryptionFailed: true,
          };
        }
      }
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
