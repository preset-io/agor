import { useMemo } from 'react';
import { useUserLocalStorage } from '../../hooks/useUserLocalStorage';
import { type AgorState, useAgorStore } from '../../store/agorStore';
import { makeHomeBucketsSelector } from '../../store/selectors';
import { NO_OPENED_FAILURES, OPENED_FAILURES_KEY, openedRunsOf } from './openedFailures';

/**
 * Home's "need you" session count (comments excluded), for a shell that shows it
 * outside Home. One selector per user and opened-failures value: patches that
 * leave the caller's sessions untouched return the memoized count, and opening a
 * failure on Home updates it in the same tab through `useUserLocalStorage`.
 */
export function useHomeNeedsCount(userId: string | undefined): number {
  const [storedOpenedFailures] = useUserLocalStorage(
    userId,
    OPENED_FAILURES_KEY,
    NO_OPENED_FAILURES
  );
  const selectNeedsCount = useMemo(() => {
    const selectBuckets = makeHomeBucketsSelector({
      userId,
      // Fixed per selector, as on Home; a newly opened failure rebuilds it.
      now: Date.now(),
      needsLimit: 0,
      recentLimit: 0,
      openedFailures: openedRunsOf(storedOpenedFailures),
    });
    return (s: AgorState) => selectBuckets(s).needsCount;
  }, [userId, storedOpenedFailures]);
  return useAgorStore(selectNeedsCount);
}
