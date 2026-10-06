/**
 * Durable failure texts written to `task.error_message`. Producers and the
 * turn outcome banner import them from here, so a rewording cannot silently
 * desynchronize the two.
 */

/** Separates Agor's fixed failure sentence from an appended closed failure code. */
export const PROVIDER_DETAIL_SEPARATOR = ' Provider detail: ';

/** Agor's fixed sentence first, so classification by identity still works. */
export function withProviderDetail(message: string, detail?: string): string {
  const trimmed = detail?.trim();
  return trimmed ? `${message}${PROVIDER_DETAIL_SEPARATOR}${trimmed}` : message;
}

export function permissionTimeoutMessage(timeoutMs: number): string {
  return `Permission request timed out after ${timeoutMs}ms.`;
}
