/**
 * Per-session composer drafts.
 *
 * localStorage-backed so a draft survives the session panel unmounting, and
 * shared so anything that wants to seed a composer writes through the same key
 * the panel reads — the marketplace connect flow pre-loads a starter prompt
 * into a session it has just created, on a surface that never mounts the panel.
 */

const DRAFT_KEY_PREFIX = 'agor-draft-';

const draftKey = (sessionId: string): string => `${DRAFT_KEY_PREFIX}${sessionId}`;

export function getPromptDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) || '';
  } catch {
    return '';
  }
}

/** Store a draft, or clear it when the value is blank. */
export function savePromptDraft(sessionId: string, value: string): void {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey(sessionId), value);
    } else {
      localStorage.removeItem(draftKey(sessionId));
    }
  } catch {
    // localStorage full or unavailable
  }
}

export function deletePromptDraft(sessionId: string): void {
  try {
    localStorage.removeItem(draftKey(sessionId));
  } catch {
    // ignore
  }
}
