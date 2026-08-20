interface SessionPromptDraftEntry {
  text: string;
  revision: number;
}

/** Caller- and authentication-generation-owned compose drafts keyed by session. */
export interface SessionPromptDraftState {
  ownerId: string | null;
  ownerGeneration: number;
  entries: ReadonlyMap<string, SessionPromptDraftEntry>;
  nextRevision: number;
}

export interface SessionPromptDraftSnapshot {
  ownerId: string | null;
  ownerGeneration: number;
  sessionId: string;
  revision: number;
}

export function createSessionPromptDraftState(
  ownerId: string | null,
  ownerGeneration: number
): SessionPromptDraftState {
  return { ownerId, ownerGeneration, entries: new Map(), nextRevision: 1 };
}

/** Switching identity or logging in again drops drafts from the previous authentication. */
export function scopeSessionPromptDraftState(
  state: SessionPromptDraftState,
  ownerId: string | null,
  ownerGeneration: number
): SessionPromptDraftState {
  return state.ownerId === ownerId && state.ownerGeneration === ownerGeneration
    ? state
    : createSessionPromptDraftState(ownerId, ownerGeneration);
}

export function readSessionPromptDrafts(
  state: SessionPromptDraftState
): ReadonlyMap<string, string> {
  return new Map([...state.entries].map(([sessionId, entry]) => [sessionId, entry.text]));
}

export function updateSessionPromptDraft(
  state: SessionPromptDraftState,
  ownerId: string | null,
  ownerGeneration: number,
  sessionId: string,
  draft: string
): SessionPromptDraftState {
  const scoped = scopeSessionPromptDraftState(state, ownerId, ownerGeneration);
  const entries = new Map(scoped.entries);
  if (draft.trim()) {
    entries.set(sessionId, { text: draft, revision: scoped.nextRevision });
  } else {
    entries.delete(sessionId);
  }
  return { ...scoped, entries, nextRevision: scoped.nextRevision + 1 };
}

/** Capture the exact draft operation that is about to be admitted. */
export function captureSessionPromptDraft(
  state: SessionPromptDraftState,
  ownerId: string | null,
  ownerGeneration: number,
  sessionId: string,
  prompt: string
): SessionPromptDraftSnapshot | undefined {
  if (state.ownerId !== ownerId || state.ownerGeneration !== ownerGeneration) return undefined;
  const entry = state.entries.get(sessionId);
  if (!entry || entry.text.trim() !== prompt.trim()) return undefined;
  return { ownerId, ownerGeneration, sessionId, revision: entry.revision };
}

/** Clear only the unchanged draft that initiated a completed operation. */
export function clearSessionPromptDraft(
  state: SessionPromptDraftState,
  snapshot: SessionPromptDraftSnapshot | undefined
): SessionPromptDraftState {
  if (
    !snapshot ||
    state.ownerId !== snapshot.ownerId ||
    state.ownerGeneration !== snapshot.ownerGeneration ||
    state.entries.get(snapshot.sessionId)?.revision !== snapshot.revision
  ) {
    return state;
  }
  const entries = new Map(state.entries);
  entries.delete(snapshot.sessionId);
  return { ...state, entries };
}
