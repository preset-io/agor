import type { AgenticToolName } from '@agor-live/client';

/**
 * Persistent, per-user+tool dismissal of a credential banner. It survives
 * reloads and time (no 24-hour snooze) and re-surfaces only when the tool's own
 * credential fingerprint changes — never when an unrelated tool is saved.
 *
 * `warning` scopes the amber "not connected / rejected" banner; `partial`
 * scopes the softened notice shown when another tool still works. Keeping them
 * apart means dismissing the informational notice never hides a later
 * all-tools-down warning.
 */
export type BannerDismissalScope = 'warning' | 'partial';

interface StoredDismissal {
  version: 2;
  fingerprint: string;
}

export function credentialWarningDismissalKey(
  scope: BannerDismissalScope,
  userId: string,
  tool: AgenticToolName
): string {
  return `agor-credential-warning-dismissed:v2:${scope}:${userId}:${tool}`;
}

/**
 * True while the stored dismissal still matches the tool's current credential
 * fingerprint. A missing, malformed, or stale (fingerprint-changed) entry is
 * removed and treated as "not dismissed", so a real warning is never hidden by
 * an out-of-date dismissal.
 */
export function readCredentialWarningDismissed(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  scope: BannerDismissalScope,
  userId: string,
  tool: AgenticToolName,
  fingerprint: string
): boolean {
  const key = credentialWarningDismissalKey(scope, userId, tool);
  try {
    const raw = storage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<StoredDismissal>;
    if (parsed.version !== 2 || parsed.fingerprint !== fingerprint) {
      storage.removeItem(key);
      return false;
    }
    return true;
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. A
    // persistence failure must not hide a real warning indefinitely.
    try {
      storage.removeItem(key);
    } catch {
      // Best effort only.
    }
    return false;
  }
}

export function writeCredentialWarningDismissed(
  storage: Pick<Storage, 'setItem'>,
  scope: BannerDismissalScope,
  userId: string,
  tool: AgenticToolName,
  fingerprint: string
): void {
  try {
    storage.setItem(
      credentialWarningDismissalKey(scope, userId, tool),
      JSON.stringify({ version: 2, fingerprint } satisfies StoredDismissal)
    );
  } catch {
    // The mounted component still honors the in-memory dismissal. A reload will
    // re-show the warning rather than silently hiding it forever.
  }
}
