import type { ShortcutDefinition } from './types';

/**
 * The canonical registry of global keyboard shortcuts.
 *
 * Key choices follow the GitHub / Linear convention of single-key shortcuts
 * for actions: they're memorable, and because we suppress shortcuts while the
 * user is typing in a field (see `isEditableTarget`), single keys never
 * collide with browser/OS chords (which are all modifier-based). The help
 * overlay is generated from this array, so adding a shortcut here is all it
 * takes to make it discoverable.
 *
 * Note: `Cmd/Ctrl+K` (global search) lives in `GlobalSearch` because it must
 * fire even while an input is focused; it is intentionally not registered
 * here. It is still listed in the help overlay for completeness.
 */
export const SHORTCUTS: ShortcutDefinition[] = [
  {
    id: 'show-help',
    keys: ['?', 'mod+/'],
    description: 'Show keyboard shortcuts',
    group: 'General',
  },
  {
    // Owned by `GlobalSearch` (it must fire while an input is focused, which
    // this system deliberately suppresses). Listed here purely so the overlay
    // documents it; no handler is registered, so our matcher leaves it to
    // GlobalSearch's own listener.
    id: 'search',
    keys: ['mod+k'],
    description: 'Search everything',
    group: 'General',
  },
  {
    id: 'board-switcher',
    keys: ['b'],
    description: 'Switch board',
    group: 'Navigation',
  },
  {
    id: 'new-session',
    keys: ['c'],
    description: 'Start a new session',
    group: 'Actions',
  },
  {
    id: 'authenticate-mcp',
    keys: ['a'],
    description: 'Authenticate MCP servers',
    group: 'Actions',
  },
];

export const SHORTCUTS_BY_ID = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s])) as Record<
  ShortcutDefinition['id'],
  ShortcutDefinition
>;
