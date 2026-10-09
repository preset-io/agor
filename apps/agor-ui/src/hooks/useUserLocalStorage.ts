import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readLocalStorageJson, writeLocalStorageJson } from './localStorageJson';

/** The per-user localStorage key; signed-out renders share the `anonymous` one. */
export const userStorageKey = (userId: string | null | undefined, key: string) =>
  `agor:user:${userId || 'anonymous'}:${key}`;

/** Same-tab write notice (`storage` only fires in other tabs); `detail` is the written key. */
const USER_STORAGE_WRITE_EVENT = 'agor:user-storage-write';

/**
 * LocalStorage hook for preferences that should be isolated per authenticated
 * user. Values are JSON-encoded just like useLocalStorage, but reads/writes are
 * skipped until a user id is available so anonymous bootstrap renders do not
 * leak preferences into a shared key. Every instance reading the same key stays
 * in sync, within this tab as well as across tabs.
 */
export function useUserLocalStorage<T>(
  userId: string | null | undefined,
  key: string,
  initialValue: T
): [T, (value: T | ((val: T) => T)) => void] {
  const storageKey = useMemo(() => (userId ? userStorageKey(userId, key) : null), [key, userId]);

  const readStoredValue = useCallback(
    (): T => (storageKey ? readLocalStorageJson(storageKey, initialValue) : initialValue),
    [initialValue, storageKey]
  );

  const [storedValue, setStoredValue] = useState<T>(readStoredValue);
  const storedValueRef = useRef(storedValue);
  storedValueRef.current = storedValue;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  // Set while this instance's own write notice is dispatched, so it skips re-reading itself.
  const writingRef = useRef(false);

  // Every value adopted from storage updates the ref first, so a functional
  // update queued before React re-renders builds on it, not on the old value.
  const adoptStoredValue = useCallback(() => {
    const value = readStoredValue();
    storedValueRef.current = value;
    setStoredValue(value);
  }, [readStoredValue]);

  useEffect(() => {
    adoptStoredValue();
  }, [adoptStoredValue]);

  // Keep per-user preferences consistent across instances and tabs, including storage clears.
  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) adoptStoredValue();
    };
    const handleWrite = (event: Event) => {
      if (!writingRef.current && (event as CustomEvent<string>).detail === storageKey) {
        adoptStoredValue();
      }
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(USER_STORAGE_WRITE_EVENT, handleWrite);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(USER_STORAGE_WRITE_EVENT, handleWrite);
    };
  }, [adoptStoredValue, storageKey]);

  const setValue = useCallback((value: T | ((val: T) => T)) => {
    const valueToStore = value instanceof Function ? value(storedValueRef.current) : value;
    storedValueRef.current = valueToStore;
    setStoredValue(valueToStore);
    const currentKey = storageKeyRef.current;
    if (currentKey && writeLocalStorageJson(currentKey, valueToStore)) {
      writingRef.current = true;
      try {
        window.dispatchEvent(new CustomEvent(USER_STORAGE_WRITE_EVENT, { detail: currentKey }));
      } finally {
        writingRef.current = false;
      }
    }
  }, []);

  return [storedValue, setValue];
}
