import { useEffect, useMemo, useState } from 'react';
import { useUserLocalStorage } from '../../hooks/useUserLocalStorage';
import { useAgorStore } from '../../store/agorStore';
import type { HomeBuckets } from '../../store/homeSelectors';
import { makeHomeBucketsSelector } from '../../store/selectors';
import { NEEDS_MAX } from './HomeNeedsYou';
import { NO_OPENED_FAILURES, OPENED_FAILURES_KEY, openedRunsOf } from './openedFailures';

/** Home's "need you" sessions (comments excluded) and the clock they were judged against. */
export type HomeNeeds = Pick<HomeBuckets, 'needs' | 'needsCount' | 'needsByReason'> & {
  now: number;
};

/** The failure window is judged against a clock refreshed this often. */
const NOW_REFRESH_MS = 60 * 60 * 1000;

/**
 * One "need you" pass for a shell that shows it outside Home (the mobile tab
 * bar badge) and hands the same result to Home, so both show one number from
 * one clock. Patches that leave the caller's sessions untouched return the
 * memoized result; opening a failure on Home updates it in the same tab
 * through `useUserLocalStorage`.
 */
export function useHomeNeeds(userId: string | undefined): HomeNeeds {
  const [storedOpenedFailures] = useUserLocalStorage(
    userId,
    OPENED_FAILURES_KEY,
    NO_OPENED_FAILURES
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const selectBuckets = useMemo(
    () =>
      makeHomeBucketsSelector({
        userId,
        now,
        needsLimit: NEEDS_MAX,
        recentLimit: 0,
        openedFailures: openedRunsOf(storedOpenedFailures),
      }),
    [userId, now, storedOpenedFailures]
  );
  const buckets = useAgorStore(selectBuckets);
  return useMemo(
    () => ({
      now,
      needs: buckets.needs,
      needsCount: buckets.needsCount,
      needsByReason: buckets.needsByReason,
    }),
    [now, buckets.needs, buckets.needsCount, buckets.needsByReason]
  );
}
