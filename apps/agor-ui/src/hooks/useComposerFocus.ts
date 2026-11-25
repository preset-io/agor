import { useSyncExternalStore } from 'react';

/**
 * Whether the session composer has focus. The phone shell hides its tab bar
 * while it does, so the composer sits right on the keyboard.
 */
let composerFocused = false;
const listeners = new Set<() => void>();

export function setComposerFocused(next: boolean): void {
  if (composerFocused === next) return;
  composerFocused = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useComposerFocused(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => composerFocused,
    () => false
  );
}
