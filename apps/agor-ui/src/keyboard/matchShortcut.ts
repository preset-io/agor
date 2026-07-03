/**
 * Pure key-matching helpers for the keyboard-shortcut system.
 *
 * Combos are written in a small DSL: modifier tokens joined by `+`, with the
 * printable key last. Recognised modifiers are `mod` (Cmd on macOS, Ctrl
 * elsewhere), `meta`, `ctrl`, `alt`, and `shift`. Examples: `'c'`, `'?'`,
 * `'mod+/'`, `'shift+d'`.
 */

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  // `navigator.platform` is deprecated but still the most reliable signal in
  // browsers; fall back to the UA string for engines that have dropped it.
  const platform = navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

interface ParsedCombo {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lower-cased printable key, e.g. `c`, `/`, `?`. */
  key: string;
}

const MODIFIERS = new Set(['mod', 'meta', 'ctrl', 'control', 'alt', 'option', 'shift']);

export function parseCombo(combo: string, mac = isMac()): ParsedCombo {
  const parsed: ParsedCombo = { meta: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const rawToken of combo.split('+')) {
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    if (MODIFIERS.has(token)) {
      switch (token) {
        case 'mod':
          if (mac) parsed.meta = true;
          else parsed.ctrl = true;
          break;
        case 'meta':
          parsed.meta = true;
          break;
        case 'ctrl':
        case 'control':
          parsed.ctrl = true;
          break;
        case 'alt':
        case 'option':
          parsed.alt = true;
          break;
        case 'shift':
          parsed.shift = true;
          break;
      }
    } else {
      parsed.key = token;
    }
  }
  return parsed;
}

/**
 * True when the event should reach a global shortcut. Returns `false` when the
 * user is typing into a form field, a contenteditable region, or any element
 * with a textbox role, so shortcuts never steal keystrokes mid-edit.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute?.('role');
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
  return false;
}

/** True when `event` matches the given combo exactly (all modifiers accounted for). */
export function matchShortcut(event: KeyboardEvent, combo: string, mac = isMac()): boolean {
  const parsed = parseCombo(combo, mac);
  if (!parsed.key) return false;

  if (event.metaKey !== parsed.meta) return false;
  if (event.ctrlKey !== parsed.ctrl) return false;
  if (event.altKey !== parsed.alt) return false;

  const eventKey = (event.key || '').toLowerCase();

  // Symbol keys that are only reachable via Shift (e.g. `?`) carry the Shift
  // requirement implicitly, so we don't second-guess `event.shiftKey` for
  // them. For everything else, Shift must match exactly.
  const keyImpliesShift = parsed.key.length === 1 && !/[a-z0-9]/.test(parsed.key);
  if (!keyImpliesShift && event.shiftKey !== parsed.shift) return false;

  return eventKey === parsed.key;
}

const KEY_LABELS: Record<string, string> = {
  '/': '/',
  '?': '?',
};

/** Render a combo as platform-appropriate key labels, e.g. `['⌘', '/']`. */
export function formatCombo(combo: string, mac = isMac()): string[] {
  const labels: string[] = [];
  for (const rawToken of combo.split('+')) {
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    switch (token) {
      case 'mod':
        labels.push(mac ? '⌘' : 'Ctrl');
        break;
      case 'meta':
        labels.push(mac ? '⌘' : 'Win');
        break;
      case 'ctrl':
      case 'control':
        labels.push(mac ? '⌃' : 'Ctrl');
        break;
      case 'alt':
      case 'option':
        labels.push(mac ? '⌥' : 'Alt');
        break;
      case 'shift':
        labels.push(mac ? '⇧' : 'Shift');
        break;
      default:
        labels.push(KEY_LABELS[token] ?? token.toUpperCase());
    }
  }
  return labels;
}
