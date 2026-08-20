import { describe, expect, it } from 'vitest';
import {
  clearSessionPromptDraft,
  createSessionPromptDraftState,
  scopeSessionPromptDraftState,
  updateSessionPromptDraft,
} from './sessionPromptDrafts';

describe('session prompt drafts', () => {
  it('does not expose one caller draft after switching identity', () => {
    const userAState = updateSessionPromptDraft(
      createSessionPromptDraftState('user-a'),
      'user-a',
      'shared-session',
      'private draft'
    );

    const userBState = scopeSessionPromptDraftState(userAState, 'user-b');

    expect(userBState.ownerId).toBe('user-b');
    expect(userBState.drafts.size).toBe(0);
  });

  it('ignores a stale completion instead of clearing the current caller draft', () => {
    const userBState = updateSessionPromptDraft(
      createSessionPromptDraftState('user-b'),
      'user-b',
      'shared-session',
      'user b draft'
    );

    const afterUserACompletion = clearSessionPromptDraft(userBState, 'user-a', 'shared-session');

    expect(afterUserACompletion).toBe(userBState);
    expect(afterUserACompletion.drafts.get('shared-session')).toBe('user b draft');
  });
});
