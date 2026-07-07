import { useCallback, useEffect, useRef, useState } from 'react';
import { readLocalStorageJson, writeLocalStorageJson } from './localStorageJson';

const LOCAL_STORAGE_CHANGE_EVENT = 'agor-local-storage-change';

interface LocalStorageChangeDetail {
  key: string;
  value: unknown;
}

/**
 * Hook for persisting state to localStorage with type safety.
 * The setter is referentially stable (safe to use in dependency arrays).
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((val: T) => T)) => void] {
  const readValue = useCallback(() => readLocalStorageJson(key, initialValue), [initialValue, key]);

  // State to store our value
  // Pass initial state function to useState so logic is only executed once
  const [storedValue, setStoredValue] = useState<T>(readValue);

  // Keep key in a ref so the callback doesn't depend on it
  const keyRef = useRef(key);
  keyRef.current = key;

  // Mirror the latest value into a ref so the functional form of `setValue` can
  // resolve against it WITHOUT persisting + dispatching from inside the
  // `setStoredValue` updater. React runs updaters during the render phase, so a
  // change event dispatched there would make a sibling hook's listener call
  // setState mid-render; keeping the side effects in the setter body (an
  // event/effect context) keeps them out of render.
  const storedValueRef = useRef(storedValue);
  storedValueRef.current = storedValue;

  // Stable setter that persists to localStorage
  const setValue = useCallback((value: T | ((val: T) => T)) => {
    try {
      const valueToStore =
        value instanceof Function ? (value as (val: T) => T)(storedValueRef.current) : value;
      writeLocalStorageJson(keyRef.current, valueToStore);
      setStoredValue(valueToStore);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
            detail: { key: keyRef.current, value: valueToStore },
          })
        );
      }
    } catch (error) {
      console.error(`Error setting localStorage key "${keyRef.current}":`, error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleStorage = (event: StorageEvent) => {
      if (event.key === key) {
        setStoredValue(readValue());
      }
    };

    const handleLocalStorageChange = (event: Event) => {
      const customEvent = event as CustomEvent<LocalStorageChangeDetail>;
      if (customEvent.detail?.key === key) {
        setStoredValue(customEvent.detail.value as T);
      }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalStorageChange);
    };
  }, [key, readValue]);

  return [storedValue, setValue];
}
