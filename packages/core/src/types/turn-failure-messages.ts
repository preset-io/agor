/**
 * Durable failure texts written to `task.error_message`. Producers and the
 * turn outcome banner import them from here, so a rewording cannot silently
 * desynchronize the two.
 */

export function permissionTimeoutMessage(timeoutMs: number): string {
  return `Permission request timed out after ${timeoutMs}ms.`;
}
