/**
 * The one persisted composer draft for the current browser.
 *
 * A draft is tied to both its user and session, so account switches cannot
 * expose it and opening another session does not move text into the wrong
 * conversation. Saving in another composer replaces the record instead of
 * accumulating one localStorage namespace per session.
 */

const DRAFT_KEY = 'agor:prompt-draft';
const DRAFT_SEED_KEY = 'agor:prompt-draft-seed';
const LEGACY_DRAFT_KEY_PREFIX = 'agor-draft-';
const DRAFT_SEED_TTL_MS = 10 * 60 * 1000;

interface StoredPromptDraft {
  ownerId: string;
  sessionId: string;
  text: string;
}

interface StoredPromptDraftSeed extends StoredPromptDraft {
  createdAt: number;
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

/**
 * Stage starter text across the modal-close/navigation boundary. This lives in
 * sessionStorage separately from the current composer's draft so the old
 * composer's unmount flush cannot overwrite it.
 */
export function stagePromptDraftSeed(ownerId: string, sessionId: string, text: string): void {
  if (!text.trim()) return;
  try {
    sessionStorage.setItem(
      DRAFT_SEED_KEY,
      JSON.stringify({ ownerId, sessionId, text, createdAt: Date.now() })
    );
  } catch {
    // sessionStorage unavailable
  }
}

/** Consume starter text only for its exact user/session, once and within TTL. */
function readSeed(
  ownerId: string | undefined,
  sessionId: string,
  now: number,
  consume: boolean
): string {
  if (!ownerId) return '';
  try {
    const raw = sessionStorage.getItem(DRAFT_SEED_KEY);
    if (!raw) return '';
    const seed = JSON.parse(raw) as Partial<StoredPromptDraftSeed>;
    const seedOwnerId = seed.ownerId;
    const seedSessionId = seed.sessionId;
    const seedText = seed.text;
    const seedCreatedAt = seed.createdAt;
    const valid =
      typeof seedOwnerId === 'string' &&
      typeof seedSessionId === 'string' &&
      typeof seedText === 'string' &&
      typeof seedCreatedAt === 'number' &&
      Number.isFinite(seedCreatedAt);
    if (
      !valid ||
      typeof seedCreatedAt !== 'number' ||
      now < seedCreatedAt ||
      now - seedCreatedAt > DRAFT_SEED_TTL_MS ||
      seedOwnerId !== ownerId
    ) {
      sessionStorage.removeItem(DRAFT_SEED_KEY);
      return '';
    }
    if (seedSessionId !== sessionId) return '';
    if (consume) sessionStorage.removeItem(DRAFT_SEED_KEY);
    return typeof seedText === 'string' ? seedText : '';
  } catch {
    try {
      sessionStorage.removeItem(DRAFT_SEED_KEY);
    } catch {
      // ignore
    }
    return '';
  }
}

/** Read an untouched starter without moving it into browser-global draft storage. */
export function readPromptDraftSeed(ownerId: string | undefined, sessionId: string): string {
  return readSeed(ownerId, sessionId, Date.now(), false);
}

/** Consume the matching starter once, when the composer edits, sends, or already has a draft. */
export function consumePromptDraftSeed(
  ownerId: string | undefined,
  sessionId: string,
  now = Date.now()
): string {
  return readSeed(ownerId, sessionId, now, true);
}

/** Clear only the departing caller's handoff, even when no composer is mounted. */
export function discardPromptDraftSeed(
  ownerId: string | undefined,
  sessionId?: string,
  expectedText?: string
): void {
  if (!ownerId) return;
  try {
    const raw = sessionStorage.getItem(DRAFT_SEED_KEY);
    const seed = raw ? (JSON.parse(raw) as Partial<StoredPromptDraftSeed>) : null;
    if (
      seed?.ownerId === ownerId &&
      (sessionId === undefined || seed.sessionId === sessionId) &&
      (expectedText === undefined || seed.text === expectedText)
    ) {
      sessionStorage.removeItem(DRAFT_SEED_KEY);
    }
  } catch {
    // Storage may be unavailable; an unreadable seed cannot hydrate a composer.
  }
}
