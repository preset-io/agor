import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { isEditableTarget, matchShortcut } from './matchShortcut';
import { SHORTCUTS } from './shortcuts';
import type { ShortcutId } from './types';

type ShortcutHandler = (event: KeyboardEvent) => void;

interface KeyboardShortcutsContextValue {
  /** Register a handler for a shortcut id. Returns an unregister fn. */
  register: (id: ShortcutId, handler: ShortcutHandler) => () => void;
  openHelp: () => void;
  closeHelp: () => void;
  toggleHelp: () => void;
  helpOpen: boolean;
}

const KeyboardShortcutsContext = createContext<KeyboardShortcutsContextValue | undefined>(
  undefined
);

/**
 * Owns the single global `keydown` listener, the handler registry, and the
 * help overlay. One listener dispatches to all shortcuts (rather than N
 * component listeners) so ordering, the editable-target guard, and
 * `preventDefault` all live in one place.
 *
 * Handlers are attached with `useKeyboardShortcut(id, handler)` from any
 * descendant; a component only handles a shortcut while it is mounted, which
 * gives us mount-scoped shortcuts for free.
 */
export const KeyboardShortcutsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const handlersRef = useRef<Map<ShortcutId, ShortcutHandler>>(new Map());
  const [helpOpen, setHelpOpen] = useState(false);

  const register = useCallback((id: ShortcutId, handler: ShortcutHandler) => {
    handlersRef.current.set(id, handler);
    return () => {
      // Only clear if we still own the slot — guards against a re-registered
      // handler being torn down by a stale cleanup.
      if (handlersRef.current.get(id) === handler) handlersRef.current.delete(id);
    };
  }, []);

  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const toggleHelp = useCallback(() => setHelpOpen((v) => !v), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Never steal keystrokes while the user is typing.
      if (isEditableTarget(event.target)) return;

      for (const shortcut of SHORTCUTS) {
        if (!shortcut.keys.some((combo) => matchShortcut(event, combo))) continue;

        // Help toggle is owned by the provider itself.
        if (shortcut.id === 'show-help') {
          event.preventDefault();
          toggleHelp();
          return;
        }

        const handler = handlersRef.current.get(shortcut.id);
        // No handler registered (e.g. `search`, owned by GlobalSearch) — leave
        // the event alone so its own listener can act.
        if (!handler) return;

        event.preventDefault();
        handler(event);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleHelp]);

  const value = useMemo<KeyboardShortcutsContextValue>(
    () => ({ register, openHelp, closeHelp, toggleHelp, helpOpen }),
    [register, openHelp, closeHelp, toggleHelp, helpOpen]
  );

  return (
    <KeyboardShortcutsContext.Provider value={value}>
      {children}
      <KeyboardShortcutsHelp open={helpOpen} onClose={closeHelp} />
    </KeyboardShortcutsContext.Provider>
  );
};

export function useKeyboardShortcutsContext(): KeyboardShortcutsContextValue {
  const ctx = useContext(KeyboardShortcutsContext);
  if (!ctx) {
    throw new Error('useKeyboardShortcutsContext must be used within a KeyboardShortcutsProvider');
  }
  return ctx;
}

/**
 * Bind a handler to a global shortcut for as long as the calling component is
 * mounted. Pass `enabled: false` to temporarily suspend the binding without
 * unmounting.
 */
export function useKeyboardShortcut(
  id: ShortcutId,
  handler: ShortcutHandler,
  enabled = true
): void {
  const { register } = useKeyboardShortcutsContext();
  // Keep the latest handler in a ref so callers can pass inline closures
  // without re-registering (and re-running the effect) on every render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    return register(id, (event) => handlerRef.current(event));
  }, [id, enabled, register]);
}
