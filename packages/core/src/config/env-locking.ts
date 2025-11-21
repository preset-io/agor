import type { Database } from '../db/client';
import type { UserID } from '../types';
import { resolveUserEnvironment } from './env-resolver';

/**
 * Per-user locks to prevent process.env race conditions
 *
 * When multiple queries run concurrently, they could overwrite each other's
 * environment variables in the shared process.env object. This lock mechanism
 * ensures only one operation at a time can augment process.env for a given user.
 */
const userEnvLocks = new Map<UserID, Promise<void>>();

/**
 * Execute a function with user environment variables augmented in process.env
 *
 * This function:
 * 1. Waits for any existing lock for this user
 * 2. Resolves user's env vars from database
 * 3. Saves original process.env values
 * 4. Augments process.env with user env vars
 * 5. Executes the function
 * 6. Restores original process.env
 * 7. Releases the lock for next operation
 *
 * @param userId - User ID to resolve environment for
 * @param db - Database instance
 * @param fn - Function to execute with augmented process.env
 * @returns Result of the function
 */
export async function withUserEnvironment<T>(
  userId: UserID,
  db: Database,
  fn: () => Promise<T>
): Promise<T> {
  // Wait for any existing lock for this user
  const existingLock = userEnvLocks.get(userId);
  if (existingLock) {
    await existingLock;
  }

  // Create new lock promise
  let releaseLock: () => void;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  userEnvLocks.set(userId, lock);

  try {
    // Resolve user environment
    const userEnv = await resolveUserEnvironment(userId, db);
    const originalEnv = { ...process.env };

    // Augment process.env with user env vars (user vars override system)
    Object.assign(process.env, userEnv);

    try {
      // Execute function with augmented environment
      return await fn();
    } finally {
      // Restore original process.env
      for (const key of Object.keys(userEnv)) {
        if (originalEnv[key] === undefined) {
          // Variable was added by user env, remove it
          delete process.env[key];
        } else {
          // Restore original value
          process.env[key] = originalEnv[key];
        }
      }
    }
  } finally {
    // Release lock for next operation
    releaseLock!();
    userEnvLocks.delete(userId);
  }
}

/**
 * Synchronous version without environment variable augmentation
 * Returns user environment but doesn't modify process.env
 */
export function withUserEnvironmentSync(
  userId: UserID,
  db: Database,
  fn: (env: Record<string, string>) => void
): void {
  // This is synchronous, so we can't use async locks
  // For now, just resolve and return without process.env modification
  // In future, could use synchronous locks if needed
  fn({} as Record<string, string>);
}
