/**
 * Session Guard Utilities
 *
 * Provides defensive programming helpers to gracefully handle sessions
 * that are deleted during async operations (race conditions).
 */

import type { SessionID } from '../types';
import type { SessionRepository } from './repositories/sessions';

/**
 * Execute an operation only if the session still exists.
 * Returns null if session was deleted, otherwise returns operation result.
 *
 * This provides a single check point for session existence, avoiding
 * scattered defensive checks throughout the codebase.
 *
 * @example
 * ```typescript
 * const result = await withSessionGuard(sessionId, sessionsRepo, async () => {
 *   // Multiple operations protected by single check
 *   await createMessage(...);
 *   await updateTask(...);
 *   return someValue;
 * });
 * if (!result) {
 *   // Session was deleted, handle gracefully
 * }
 * ```
 */
export async function withSessionGuard<T>(
  sessionId: SessionID,
  sessionsRepo: SessionRepository | undefined,
  operation: () => Promise<T>
): Promise<T | null> {
  // Check session exists before executing operation
  const sessionExists = await sessionsRepo?.findById(sessionId);
  if (!sessionExists) {
    console.warn(
      `⚠️  Session ${sessionId.substring(0, 8)} no longer exists, skipping guarded operation`
    );
    return null;
  }

  return operation();
}

/**
 * Check if an error is a foreign key constraint violation.
 * Used to detect when a session was deleted mid-operation.
 */
export function isForeignKeyConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('FOREIGN KEY constraint failed') ||
      error.message.includes('SQLITE_CONSTRAINT_FOREIGNKEY'))
  );
}
