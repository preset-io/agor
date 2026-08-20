/** Caller-owned compose drafts keyed by session. */
export interface SessionPromptDraftState {
  ownerId: string | null;
  drafts: ReadonlyMap<string, string>;
}

export function createSessionPromptDraftState(ownerId: string | null): SessionPromptDraftState {
  return { ownerId, drafts: new Map() };
}

/** Switching identity drops drafts that belonged to the previous caller. */
export function scopeSessionPromptDraftState(
  state: SessionPromptDraftState,
  ownerId: string | null
): SessionPromptDraftState {
  return state.ownerId === ownerId ? state : createSessionPromptDraftState(ownerId);
}

export function updateSessionPromptDraft(
  state: SessionPromptDraftState,
  ownerId: string | null,
  sessionId: string,
  draft: string
): SessionPromptDraftState {
  const scoped = scopeSessionPromptDraftState(state, ownerId);
  const drafts = new Map(scoped.drafts);
  if (draft.trim()) {
    drafts.set(sessionId, draft);
  } else {
    drafts.delete(sessionId);
  }
  return { ...scoped, drafts };
}

/** Ignore a delayed completion after its initiating caller no longer owns the state. */
export function clearSessionPromptDraft(
  state: SessionPromptDraftState,
  operationOwnerId: string | null,
  sessionId: string
): SessionPromptDraftState {
  if (state.ownerId !== operationOwnerId || !state.drafts.has(sessionId)) return state;
  const drafts = new Map(state.drafts);
  drafts.delete(sessionId);
  return { ...state, drafts };
}
