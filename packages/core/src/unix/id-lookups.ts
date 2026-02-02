/**
 * Cross-platform utilities for looking up Unix UIDs and GIDs
 *
 * Supports both Linux (using getent) and macOS (parsing /etc/group and /etc/passwd)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Get GID (group ID) from Unix group name
 *
 * Strategy:
 * 1. Try `getent group` first (available on Linux, some BSD)
 * 2. Fallback to parsing /etc/group (macOS, older systems)
 * 3. Never throw - return undefined if lookup fails
 *
 * @param groupName - Unix group name to lookup
 * @returns GID number, or undefined if not found or error
 */
export function getGidFromGroupName(groupName: string | undefined | null): number | undefined {
  if (!groupName) {
    return undefined;
  }

  try {
    // Try getent first (Linux, some BSD)
    try {
      const result = execSync(`getent group "${groupName}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 2000,
      }).trim();

      // Format: groupname:password:GID:user_list
      const parts = result.split(':');
      if (parts.length >= 3) {
        const gid = parseInt(parts[2], 10);
        if (!Number.isNaN(gid)) {
          return gid;
        }
      }
    } catch {
      // getent not available or group not found, try fallback
    }

    // Fallback to /etc/group (macOS, older systems)
    if (fs.existsSync('/etc/group')) {
      const groupFile = fs.readFileSync('/etc/group', 'utf-8');
      const line = groupFile.split('\n').find((l) => l.startsWith(`${groupName}:`));

      if (line) {
        const parts = line.split(':');
        if (parts.length >= 3) {
          const gid = parseInt(parts[2], 10);
          if (!Number.isNaN(gid)) {
            return gid;
          }
        }
      }
    }

    console.warn(`⚠️  Could not lookup GID for group '${groupName}'`);
    return undefined;
  } catch (error) {
    console.warn(
      `⚠️  Failed to lookup GID for group '${groupName}':`,
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}

/**
 * Get UID (user ID) from Unix username
 *
 * Strategy:
 * 1. Try `id -u` command first (fastest, most reliable)
 * 2. Fallback to `getent passwd` (Linux, some BSD)
 * 3. Fallback to parsing /etc/passwd (macOS, older systems)
 * 4. Never throw - return undefined if lookup fails
 *
 * @param username - Unix username to lookup
 * @returns UID number, or undefined if not found or error
 */
export function getUidFromUsername(username: string | undefined | null): number | undefined {
  if (!username) {
    return undefined;
  }

  try {
    // Try `id -u username` first (most reliable)
    try {
      const result = execSync(`id -u "${username}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 2000,
      }).trim();

      const uid = parseInt(result, 10);
      if (!Number.isNaN(uid)) {
        return uid;
      }
    } catch {
      // id command failed, try getent
    }

    // Try getent (Linux, some BSD)
    try {
      const result = execSync(`getent passwd "${username}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 2000,
      }).trim();

      // Format: username:password:UID:GID:GECOS:directory:shell
      const parts = result.split(':');
      if (parts.length >= 3) {
        const uid = parseInt(parts[2], 10);
        if (!Number.isNaN(uid)) {
          return uid;
        }
      }
    } catch {
      // getent not available, try /etc/passwd
    }

    // Fallback to /etc/passwd (macOS, older systems)
    if (fs.existsSync('/etc/passwd')) {
      const passwdFile = fs.readFileSync('/etc/passwd', 'utf-8');
      const line = passwdFile.split('\n').find((l) => l.startsWith(`${username}:`));

      if (line) {
        const parts = line.split(':');
        if (parts.length >= 3) {
          const uid = parseInt(parts[2], 10);
          if (!Number.isNaN(uid)) {
            return uid;
          }
        }
      }
    }

    console.warn(`⚠️  Could not lookup UID for username '${username}'`);
    return undefined;
  } catch (error) {
    console.warn(
      `⚠️  Failed to lookup UID for username '${username}':`,
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}
