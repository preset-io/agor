import { createContext, useContext, useEffect } from 'react';

/**
 * Pins the surrounding turn's full detail in the lean transcript cache and
 * returns its release. Provided per turn by TaskBlock; absent elsewhere.
 */
export const TaskDetailRetention = createContext<(() => (() => void) | undefined) | undefined>(
  undefined
);

/** Keep the surrounding turn's tool/reasoning detail cached while `shown`. */
export function useRetainTaskDetailsWhile(shown: boolean): void {
  const retain = useContext(TaskDetailRetention);
  useEffect(() => {
    if (shown) return retain?.();
  }, [shown, retain]);
}
