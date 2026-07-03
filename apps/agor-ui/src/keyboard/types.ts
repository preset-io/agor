/**
 * Keyboard-shortcut type definitions.
 *
 * The registry in `shortcuts.ts` is the single source of truth for every
 * global shortcut: it drives both the key matching (`matchShortcut`) and the
 * discoverable help overlay (`KeyboardShortcutsHelp`), so the two can never
 * drift apart.
 */

/** Stable identifiers for every registered shortcut. */
export type ShortcutId =
  | 'new-session'
  | 'board-switcher'
  | 'authenticate-mcp'
  | 'show-help'
  | 'search';

/** Grouping used to organise the help overlay into labelled sections. */
export type ShortcutGroup = 'General' | 'Navigation' | 'Actions';

export interface ShortcutDefinition {
  id: ShortcutId;
  /**
   * Key combo(s) that trigger this shortcut, in the mini-DSL understood by
   * `matchShortcut` (e.g. `'c'`, `'?'`, `'mod+/'`). The first entry is the
   * one shown in the help overlay; extra entries are accepted aliases.
   */
  keys: string[];
  /** Human-readable label shown in the help overlay. */
  description: string;
  group: ShortcutGroup;
}
