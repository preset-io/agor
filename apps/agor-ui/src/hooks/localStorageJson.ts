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

export function writeLocalStorageJson<T>(key: string, value: T): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Error setting localStorage key "${key}":`, error);
    return false;
  }
}

const migratedLegacyKeys = new Set<string>();

/**
 * Hands a retired key's value to `adopt` at most once per page load, and removes the key only
 * when `adopt` reports it safely stored; storage errors read as absent.
 */
export function migrateLegacyLocalStorageJson(
  key: string,
  adopt: (value: unknown) => boolean
): void {
  if (typeof window === 'undefined' || migratedLegacyKeys.has(key)) return;
  migratedLegacyKeys.add(key);
  try {
    const item = window.localStorage.getItem(key);
    if (item === null) return;
    if (adopt(JSON.parse(item))) window.localStorage.removeItem(key);
  } catch {
    // Unreadable or blocked storage keeps the key for a later load.
  }
}
