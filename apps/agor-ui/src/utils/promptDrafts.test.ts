import { beforeEach, describe, expect, it } from 'vitest';
import { deletePromptDraft, getPromptDraft, savePromptDraft } from './promptDrafts';

describe('promptDrafts', () => {
  beforeEach(() => localStorage.clear());

  it('keeps one user- and session-scoped draft across reloads', () => {
    savePromptDraft('user-a', 'session-a', 'hello');

    expect(getPromptDraft('user-a', 'session-a')).toBe('hello');
    expect(getPromptDraft('user-b', 'session-a')).toBe('');
    expect(getPromptDraft('user-a', 'session-b')).toBe('');
    expect(localStorage.length).toBe(1);
  });

  it('replaces the previous composer instead of accumulating session keys', () => {
    savePromptDraft('user-a', 'session-a', 'first');
    savePromptDraft('user-a', 'session-b', 'second');

    expect(getPromptDraft('user-a', 'session-a')).toBe('');
    expect(getPromptDraft('user-a', 'session-b')).toBe('second');
    expect(localStorage.length).toBe(1);
  });

  it('does not let a delayed send clear replacement text', () => {
    savePromptDraft('user-a', 'session-a', 'first');
    savePromptDraft('user-a', 'session-a', 'replacement');

    deletePromptDraft('user-a', 'session-a', 'first');

    expect(getPromptDraft('user-a', 'session-a')).toBe('replacement');
  });

  it('prunes legacy per-session keys', () => {
    localStorage.setItem('agor-draft-old-session', 'old');
    savePromptDraft('user-a', 'session-a', 'current');

    expect(localStorage.getItem('agor-draft-old-session')).toBeNull();
    expect(localStorage.length).toBe(1);
  });
});
