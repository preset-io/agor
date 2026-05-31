import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * LocalStorage hook for preferences that should be isolated per authenticated
 * user. Values are JSON-encoded just like useLocalStorage, but reads/writes are
 * skipped until a user id is available so anonymous bootstrap renders do not
 * leak preferences into a shared key.
 */
export function useUserLocalStorage<T>(
  userId: string | null | undefined,
  key: string,
  initialValue: T
): [T, (value: T | ((val: T) => T)) => void] {
  const storageKey = useMemo(() => (userId ? `agor:user:${userId}:${key}` : null), [key, userId]);

  const readStoredValue = useCallback((): T => {
    if (typeof window === 'undefined' || !storageKey) {
      return initialValue;
    }

    try {
      const item = window.localStorage.getItem(storageKey);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error reading localStorage key "${storageKey}":`, error);
      return initialValue;
    }
  }, [initialValue, storageKey]);

  const [storedValue, setStoredValue] = useState<T>(readStoredValue);
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  useEffect(() => {
    setStoredValue(readStoredValue());
  }, [readStoredValue]);

  const setValue = useCallback((value: T | ((val: T) => T)) => {
    try {
      setStoredValue((prev) => {
        const valueToStore = value instanceof Function ? value(prev) : value;
        const currentKey = storageKeyRef.current;
        if (typeof window !== 'undefined' && currentKey) {
          window.localStorage.setItem(currentKey, JSON.stringify(valueToStore));
        }
        return valueToStore;
      });
    } catch (error) {
      console.error(`Error setting localStorage key "${storageKeyRef.current}":`, error);
    }
  }, []);

  return [storedValue, setValue];
}
