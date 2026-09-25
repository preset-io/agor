/**
 * Authentication utilities for CLI
 *
 * Handles JWT token storage and retrieval for daemon authentication
 */

import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureAgorHome, getAgorHome } from '@agor/core/config';
import { PERSONAL_API_KEY_PREFIX, type UserApiKeySource } from '@agor/core/types';

const AGOR_DIR = getAgorHome();
const TOKEN_FILE = join(AGOR_DIR, 'cli-token');

export interface StoredAuthTarget {
  url: string;
  origin: string;
  deploymentId: string;
}

export interface StoredAuthUser {
  user_id: string;
  email: string;
  name?: string;
  role: string;
}

/** Password login: a short-lived access JWT bound to one deployment. */
export interface StoredJwtAuth {
  version: 2;
  target: StoredAuthTarget;
  accessToken: string;
  user: StoredAuthUser;
  expiresAt: number;
}

/**
 * Personal API key login. The key is sent on every request and is bound
 * server-side to the workspace URL it was created in, so the CLI pins only the
 * origin, not the Cell-derived deployment ID, which changes when a hosted
 * workspace moves between Cells. `tenantId` is the tenant reported at login,
 * kept for display; the server enforces the binding.
 */
export interface StoredApiKeyAuth {
  version: 3;
  kind: 'api-key';
  target: StoredAuthTarget & { tenantId?: string };
  apiKey: string;
  /** Server id of the key (never secret); lets `agor logout` delete a CLI-minted key. */
  apiKeyId?: string;
  /** `cli_login` keys were minted for this machine and are deleted on logout. */
  apiKeySource?: UserApiKeySource;
  user: StoredAuthUser;
}

export type StoredAuth = StoredJwtAuth | StoredApiKeyAuth;

/**
 * Save authentication token to disk
 */
export async function saveToken(auth: StoredAuth): Promise<void> {
  // Remote login can be the first local Agor command. Create a missing state
  // home privately without changing an existing operator-managed directory.
  await ensureAgorHome(AGOR_DIR);

  // Write token file with restrictive permissions
  await writeFile(TOKEN_FILE, JSON.stringify(auth, null, 2), {
    mode: 0o600, // Owner read/write only
  });
  await chmod(TOKEN_FILE, 0o600);
}

/**
 * Load authentication token from disk
 */
export async function loadToken(): Promise<StoredAuth | null> {
  try {
    const data = await readFile(TOKEN_FILE, 'utf-8');
    const auth = JSON.parse(data) as {
      version?: unknown;
      kind?: unknown;
      target?: Partial<StoredApiKeyAuth['target']>;
      accessToken?: unknown;
      apiKey?: unknown;
      user?: unknown;
      expiresAt?: unknown;
    };

    if (
      auth.version === 3 &&
      auth.kind === 'api-key' &&
      auth.target?.url &&
      auth.target?.origin &&
      typeof auth.apiKey === 'string' &&
      auth.apiKey.startsWith(PERSONAL_API_KEY_PREFIX) &&
      auth.user
    ) {
      return auth as unknown as StoredApiKeyAuth;
    }

    // Legacy tokens were not bound to an origin or deployment and must never
    // be sent speculatively to the currently configured URL.
    if (
      auth.version !== 2 ||
      !auth.target?.url ||
      !auth.target?.origin ||
      !auth.target.deploymentId ||
      !auth.accessToken ||
      !auth.user
    ) {
      return null;
    }

    // Check if token is expired
    if (typeof auth.expiresAt === 'number' && Date.now() > auth.expiresAt) {
      // Token expired, remove it
      await clearToken();
      return null;
    }

    return auth as unknown as StoredJwtAuth;
  } catch {
    // File doesn't exist or is invalid
    return null;
  }
}

/**
 * Clear stored authentication token
 */
export async function clearToken(): Promise<void> {
  try {
    await unlink(TOKEN_FILE);
  } catch {
    // File doesn't exist, that's fine
  }
}
