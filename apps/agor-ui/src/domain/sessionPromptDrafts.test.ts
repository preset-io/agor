import { describe, expect, it } from 'vitest';
import {
  captureSessionPromptDraft,
  clearSessionPromptDraft,
  createSessionPromptDraftState,
  readSessionPromptDrafts,
  scopeSessionPromptDraftState,
  updateSessionPromptDraft,
} from './sessionPromptDrafts';

describe('session prompt drafts', () => {
  it('does not expose one caller draft after switching identity', () => {
    const userAState = updateSessionPromptDraft(
      createSessionPromptDraftState('user-a', 0),
      'user-a',
      0,
      'shared-session',
      'private draft'
    );

    const userBState = scopeSessionPromptDraftState(userAState, 'user-b', 1);

    expect(userBState.ownerId).toBe('user-b');
    expect(readSessionPromptDrafts(userBState).size).toBe(0);
  });

  it('ignores a stale completion instead of clearing the current caller draft', () => {
    const userAState = updateSessionPromptDraft(
      createSessionPromptDraftState('user-a', 0),
      'user-a',
      0,
      'shared-session',
      'user a draft'
    );
    const userASnapshot = captureSessionPromptDraft(
      userAState,
      'user-a',
      0,
      'shared-session',
      'user a draft'
    );
    const userBState = updateSessionPromptDraft(
      scopeSessionPromptDraftState(userAState, 'user-b', 1),
      'user-b',
      1,
      'shared-session',
      'user b draft'
    );

    const afterUserACompletion = clearSessionPromptDraft(userBState, userASnapshot);

    expect(afterUserACompletion).toBe(userBState);
    expect(readSessionPromptDrafts(afterUserACompletion).get('shared-session')).toBe(
      'user b draft'
    );
  });

  it('preserves a replacement draft typed while the previous send is pending', () => {
    const firstDraft = updateSessionPromptDraft(
      createSessionPromptDraftState('user-a', 0),
      'user-a',
      0,
      'session-1',
      'draft A'
    );
    const firstSend = captureSessionPromptDraft(firstDraft, 'user-a', 0, 'session-1', 'draft A');
    const replacementDraft = updateSessionPromptDraft(
      firstDraft,
      'user-a',
      0,
      'session-1',
      'draft B'
    );

    const afterFirstCompletion = clearSessionPromptDraft(replacementDraft, firstSend);

    expect(afterFirstCompletion).toBe(replacementDraft);
    expect(readSessionPromptDrafts(afterFirstCompletion).get('session-1')).toBe('draft B');
  });

  it('does not clear a draft from a later login by the same user', () => {
    const firstLogin = updateSessionPromptDraft(
      createSessionPromptDraftState('user-a', 0),
      'user-a',
      0,
      'session-1',
      'draft A'
    );
    const firstSend = captureSessionPromptDraft(firstLogin, 'user-a', 0, 'session-1', 'draft A');
    const secondLogin = updateSessionPromptDraft(
      scopeSessionPromptDraftState(firstLogin, 'user-a', 2),
      'user-a',
      2,
      'session-1',
      'draft B'
    );

    expect(clearSessionPromptDraft(secondLogin, firstSend)).toBe(secondLogin);
  });
});
