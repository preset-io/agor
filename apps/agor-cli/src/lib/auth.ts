/**
 * Authentication utilities for CLI
 *
 * Handles JWT token storage and retrieval for daemon authentication
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGOR_DIR = join(homedir(), '.agor');
const TOKEN_FILE = join(AGOR_DIR, 'cli-token');

export interface StoredAuth {
  accessToken: string;
  user: {
    user_id: string;
    email: string;
    name?: string;
    role: string;
  };
  expiresAt: number;
}

/**
 * Save authentication token to disk
 */
export async function saveToken(auth: StoredAuth): Promise<void> {
  // Ensure .agor directory exists
  await mkdir(AGOR_DIR, { recursive: true });

  // Write token file with restrictive permissions
  await writeFile(TOKEN_FILE, JSON.stringify(auth, null, 2), {
    mode: 0o600, // Owner read/write only
  });
}

/**
 * Load authentication token from disk
 */
export async function loadToken(): Promise<StoredAuth | null> {
  try {
    const data = await readFile(TOKEN_FILE, 'utf-8');
    const auth = JSON.parse(data) as StoredAuth;

    // Check if token is expired
    if (auth.expiresAt && Date.now() > auth.expiresAt) {
      // Token expired, remove it
      await clearToken();
      return null;
    }

    return auth;
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
