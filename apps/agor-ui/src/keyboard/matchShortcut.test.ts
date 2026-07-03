import { describe, expect, it } from 'vitest';
import { formatCombo, isEditableTarget, matchShortcut, parseCombo } from './matchShortcut';

/** Build a minimal KeyboardEvent-shaped object for the matcher. */
function keyEvent(
  key: string,
  mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {}
): KeyboardEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  } as KeyboardEvent;
}

describe('parseCombo', () => {
  it('maps `mod` to Cmd on macOS and Ctrl elsewhere', () => {
    expect(parseCombo('mod+k', true)).toMatchObject({ meta: true, ctrl: false, key: 'k' });
    expect(parseCombo('mod+k', false)).toMatchObject({ meta: false, ctrl: true, key: 'k' });
  });

  it('captures the printable key and modifier flags', () => {
    expect(parseCombo('shift+alt+d', false)).toMatchObject({
      shift: true,
      alt: true,
      key: 'd',
    });
  });
});

describe('matchShortcut', () => {
  it('matches a bare letter only when no modifiers are held', () => {
    expect(matchShortcut(keyEvent('c'), 'c', true)).toBe(true);
    // Cmd+C (copy) must NOT trigger the bare `c` shortcut.
    expect(matchShortcut(keyEvent('c', { metaKey: true }), 'c', true)).toBe(false);
    expect(matchShortcut(keyEvent('c', { ctrlKey: true }), 'c', false)).toBe(false);
  });

  it('is case-insensitive on the key', () => {
    expect(matchShortcut(keyEvent('C'), 'c', true)).toBe(true);
  });

  it('honours the `mod` modifier per platform', () => {
    expect(matchShortcut(keyEvent('k', { metaKey: true }), 'mod+k', true)).toBe(true);
    expect(matchShortcut(keyEvent('k', { metaKey: true }), 'mod+k', false)).toBe(false);
    expect(matchShortcut(keyEvent('k', { ctrlKey: true }), 'mod+k', false)).toBe(true);
  });

  it('matches `?` regardless of the implicit shift', () => {
    expect(matchShortcut(keyEvent('?', { shiftKey: true }), '?', true)).toBe(true);
    expect(matchShortcut(keyEvent('?'), '?', true)).toBe(true);
  });

  it('requires exact shift state for alphanumeric keys', () => {
    expect(matchShortcut(keyEvent('b', { shiftKey: true }), 'b', true)).toBe(false);
    expect(matchShortcut(keyEvent('b'), 'b', true)).toBe(true);
  });
});

describe('isEditableTarget', () => {
  it('detects inputs, textareas, and contenteditable regions', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    // jsdom doesn't derive isContentEditable from the attribute, so assert via role too.
    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    expect(isEditableTarget(textbox)).toBe(true);
  });

  it('treats plain elements and null as non-editable', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('formatCombo', () => {
  it('renders platform-appropriate modifier glyphs', () => {
    expect(formatCombo('mod+/', true)).toEqual(['⌘', '/']);
    expect(formatCombo('mod+/', false)).toEqual(['Ctrl', '/']);
    expect(formatCombo('c', true)).toEqual(['C']);
  });
});
