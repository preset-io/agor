/**
 * Shared helpers for gateway connectors.
 *
 * Small utilities used by more than one connector (e.g. the polling GitHub and
 * Shortcut connectors). Kept here so the connectors stay DRY.
 */

/** Escape a string for safe interpolation into a `RegExp`. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Add an id to a bounded dedup set, evicting the oldest entries once it grows
 * past `maxSize`. Sets iterate in insertion order, so the head is the oldest.
 */
export function addToRingBuffer<T>(set: Set<T>, id: T, maxSize = 1000): void {
  set.add(id);
  if (set.size > maxSize) {
    for (const oldest of [...set].slice(0, set.size - maxSize)) {
      set.delete(oldest);
    }
  }
}
