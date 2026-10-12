import { useCallback, useEffect, useRef } from 'react';
import type { DataMaps } from '../store/agorMaps';
import { useAgorStore } from '../store/agorStore';
import { pinRows } from '../store/retention';

type Ids = readonly (string | null | undefined)[] | undefined;

const keyOf = (ids: Ids) => [...new Set(ids?.filter((id): id is string => !!id))].sort().join(',');
const split = (key: string) => (key ? key.split(',') : []);

/**
 * Pin the rows a mounted view displays (`rowPins.ts`): kept while it is
 * mounted even when no scope holds them, evicted on release when nothing else
 * does. A change pins the new ids before releasing the old ones, so an id in
 * both is never evicted in between.
 */
export function usePinnedRows(ids: { sessions?: Ids; branches?: Ids }): void {
  const sessionKey = keyOf(ids.sessions);
  const branchKey = keyOf(ids.branches);
  const release = useRef<(() => void) | null>(null);
  useEffect(() => {
    const previous = release.current;
    release.current =
      sessionKey || branchKey
        ? pinRows({ sessions: split(sessionKey), branches: split(branchKey) })
        : null;
    previous?.();
  }, [sessionKey, branchKey]);
  useEffect(
    () => () => {
      release.current?.();
      release.current = null;
    },
    []
  );
}

/**
 * Pin the sessions and branches a route or selection opens (full ids), with
 * each open session's branch.
 */
export function usePinnedOpenRows(open: { sessions?: Ids; branches?: Ids }): void {
  const sessionKey = keyOf(open.sessions);
  const sessionBranches = useAgorStore(
    useCallback(
      (s: DataMaps) => keyOf(split(sessionKey).map((id) => s.sessionById.get(id)?.branch_id)),
      [sessionKey]
    )
  );
  usePinnedRows({
    sessions: split(sessionKey),
    branches: [...(open.branches ?? []), ...split(sessionBranches)],
  });
}
