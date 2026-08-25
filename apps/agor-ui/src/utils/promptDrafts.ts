/**
 * The one persisted composer draft for the current browser.
 *
 * A draft is tied to both its user and session, so account switches cannot
 * expose it and opening another session does not move text into the wrong
 * conversation. Saving in another composer replaces the record instead of
 * accumulating one localStorage namespace per session.
 */

const DRAFT_KEY = 'agor:prompt-draft';
const LEGACY_DRAFT_KEY_PREFIX = 'agor-draft-';

interface StoredPromptDraft {
  ownerId: string;
  sessionId: string;
  text: string;
}

function pruneLegacyDraftKeys(): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_DRAFT_KEY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable
  }
}

function readStoredDraft(): StoredPromptDraft | null {
  pruneLegacyDraftKeys();
  try {
    const value = localStorage.getItem(DRAFT_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<StoredPromptDraft>;
    return typeof parsed.ownerId === 'string' &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.text === 'string'
      ? (parsed as StoredPromptDraft)
      : null;
  } catch {
    return null;
  }
}

export function getPromptDraft(ownerId: string | undefined, sessionId: string): string {
  if (!ownerId) return '';
  const draft = readStoredDraft();
  return draft?.ownerId === ownerId && draft.sessionId === sessionId ? draft.text : '';
}

/** Store a draft, replacing any draft for a different composer. */
export function savePromptDraft(
  ownerId: string | undefined,
  sessionId: string,
  value: string
): void {
  if (!ownerId) return;
  pruneLegacyDraftKeys();
  try {
    if (value.trim()) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ownerId, sessionId, text: value }));
    } else {
      deletePromptDraft(ownerId, sessionId);
    }
  } catch {
    // localStorage full or unavailable
  }
}

/**
 * Clear only the draft this operation owns. `expectedText` prevents a delayed
 * send from deleting a replacement typed before its response arrived.
 */
export function deletePromptDraft(
  ownerId: string | undefined,
  sessionId: string,
  expectedText?: string
): void {
  if (!ownerId) return;
  try {
    const draft = readStoredDraft();
    if (
      draft?.ownerId === ownerId &&
      draft.sessionId === sessionId &&
      (expectedText === undefined || draft.text === expectedText)
    ) {
      localStorage.removeItem(DRAFT_KEY);
    }
  } catch {
    // ignore
  }
}
