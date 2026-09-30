export function readLocalStorageJson<T>(key: string, initialValue: T): T {
  if (typeof window === 'undefined') {
    return initialValue;
  }

  try {
    const item = window.localStorage.getItem(key);
    return item ? JSON.parse(item) : initialValue;
  } catch (error) {
    console.error(`Error reading localStorage key "${key}":`, error);
    return initialValue;
  }
}

export function writeLocalStorageJson<T>(key: string, value: T): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Error setting localStorage key "${key}":`, error);
  }
}

const droppedLegacyKeys = new Set<string>();

/** Removes a retired key, at most once per page load; storage errors are ignored. */
export function dropLegacyLocalStorageKey(key: string): void {
  if (typeof window === 'undefined' || droppedLegacyKeys.has(key)) return;
  droppedLegacyKeys.add(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Blocked storage has nothing to clean up.
  }
}
