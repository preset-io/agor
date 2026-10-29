import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumePromptDraftSeed,
  deletePromptDraft,
  discardPromptDraftSeed,
  getPromptDraft,
  promptDraftSeedProvenance,
  savePromptDraft,
  stagePromptDraftSeed,
} from './promptDrafts';

describe('promptDrafts', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

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

  it('hands a staged starter prompt to only its exact user and session, once', () => {
    stagePromptDraftSeed('user-a', 'session-new', 'Editable starter');

    expect(consumePromptDraftSeed('user-a', 'session-other')).toBe('');
    expect(consumePromptDraftSeed('user-a', 'session-new')).toBe('Editable starter');
    expect(consumePromptDraftSeed('user-a', 'session-new')).toBe('');
  });

  it('drops a seed on an authority change or after its short bootstrap lifetime', () => {
    const now = Date.now();
    stagePromptDraftSeed('user-a', 'session-new', 'Private starter');
    expect(consumePromptDraftSeed('user-b', 'session-new', now)).toBe('');

    stagePromptDraftSeed('user-a', 'session-new', 'Stale starter');
    expect(consumePromptDraftSeed('user-a', 'session-new', now + 11 * 60 * 1000)).toBe('');
  });

  it('classifies a send against a sourced starter after the composer takes it', () => {
    stagePromptDraftSeed('user-a', 'session-new', 'List my issues', 'catalog');
    expect(consumePromptDraftSeed('user-a', 'session-new')).toBe('List my issues');
    expect(consumePromptDraftSeed('user-a', 'session-new')).toBe('');
    expect(promptDraftSeedProvenance('user-a', 'session-new', ' List my issues\n')).toBe(
      'catalog_unchanged'
    );
    expect(promptDraftSeedProvenance('user-a', 'session-new', 'Only urgent ones')).toBe(
      'catalog_edited'
    );
    expect(promptDraftSeedProvenance('user-b', 'session-new', 'List my issues')).toBeUndefined();
    expect(promptDraftSeedProvenance('user-a', 'session-other', 'List my issues')).toBeUndefined();
    discardPromptDraftSeed('user-a', 'session-new');
    expect(promptDraftSeedProvenance('user-a', 'session-new', 'List my issues')).toBeUndefined();
  });

  it('reports no provenance for an unsourced or expired starter', () => {
    const now = Date.now();
    stagePromptDraftSeed('user-a', 'session-new', 'Plain starter');
    expect(promptDraftSeedProvenance('user-a', 'session-new', 'Plain starter')).toBeUndefined();
    stagePromptDraftSeed('user-a', 'session-new', 'Welcome', 'onboarding');
    expect(
      promptDraftSeedProvenance('user-a', 'session-new', 'Welcome', now + 11 * 60 * 1000)
    ).toBeUndefined();
  });
});
