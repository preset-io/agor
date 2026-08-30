import type { AgenticToolName } from '@agor-live/client';

export const CREDENTIAL_WARNING_SNOOZE_MS = 24 * 60 * 60 * 1000;

interface CredentialWarningDismissal {
  version: 1;
  snoozedUntil: number;
}

export function credentialWarningSnoozeStorageKey(userId: string, tool: AgenticToolName): string {
  return `agor:credential-warning:v1:${userId}:${tool}`;
}

/** Read one user/tool-scoped snooze, deleting malformed or expired state. */
export function readCredentialWarningSnooze(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  userId: string,
  tool: AgenticToolName,
  now = Date.now()
): number | null {
  const key = credentialWarningSnoozeStorageKey(userId, tool);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CredentialWarningDismissal>;
    if (
      parsed.version !== 1 ||
      typeof parsed.snoozedUntil !== 'number' ||
      !Number.isFinite(parsed.snoozedUntil) ||
      parsed.snoozedUntil <= now
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed.snoozedUntil;
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. A
    // persistence failure must not hide a real warning indefinitely.
    try {
      storage.removeItem(key);
    } catch {
      // Best effort only.
    }
    return null;
  }
}

/** Snooze one user's warning for one tool. Returns the in-memory expiry. */
export function writeCredentialWarningSnooze(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  tool: AgenticToolName,
  now = Date.now()
): number {
  const snoozedUntil = now + CREDENTIAL_WARNING_SNOOZE_MS;
  try {
    storage.setItem(
      credentialWarningSnoozeStorageKey(userId, tool),
      JSON.stringify({ version: 1, snoozedUntil } satisfies CredentialWarningDismissal)
    );
  } catch {
    // The mounted component still honors the in-memory snooze. A reload will
    // show the warning again rather than silently hiding it forever.
  }
  return snoozedUntil;
}

export function clearCredentialWarningSnooze(
  storage: Pick<Storage, 'removeItem'>,
  userId: string,
  tool: AgenticToolName
): void {
  try {
    storage.removeItem(credentialWarningSnoozeStorageKey(userId, tool));
  } catch {
    // Best effort only.
  }
}
