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

const takenLegacyKeys = new Set<string>();

/** Reads and removes a retired key, at most once per page load; storage errors read as absent. */
export function takeLegacyLocalStorageJson<T>(key: string): T | undefined {
  if (typeof window === 'undefined' || takenLegacyKeys.has(key)) return undefined;
  takenLegacyKeys.add(key);
  try {
    const item = window.localStorage.getItem(key);
    window.localStorage.removeItem(key);
    return item ? (JSON.parse(item) as T) : undefined;
  } catch {
    return undefined;
  }
}
