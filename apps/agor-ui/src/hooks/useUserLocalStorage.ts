import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readLocalStorageJson, writeLocalStorageJson } from './localStorageJson';

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

  const readStoredValue = useCallback(
    (): T => (storageKey ? readLocalStorageJson(storageKey, initialValue) : initialValue),
    [initialValue, storageKey]
  );

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
        if (currentKey) {
          writeLocalStorageJson(currentKey, valueToStore);
        }
        return valueToStore;
      });
    } catch (error) {
      console.error(`Error setting localStorage key "${storageKeyRef.current}":`, error);
    }
  }, []);

  return [storedValue, setValue];
}
