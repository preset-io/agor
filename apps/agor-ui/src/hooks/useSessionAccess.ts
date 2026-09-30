import type { AgorClient, EffectiveBranchAccess } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnectionState } from '../contexts/ConnectionContext';
import { peekAccess, readAccess } from '../utils/accessCache';
import { canStartSessions } from '../utils/branchAccess';

const canStartSessionsOn = (client: AgorClient, branchId: string) =>
  client
    .service('branches/:id/effective-access')
    .find({ route: { id: branchId } })
    .then((access) => canStartSessions(access as unknown as EffectiveBranchAccess));

const NO_FAILURES: ReadonlySet<string> = new Set();

/**
 * Session access for the given teammates, read through the shared access cache.
 * Unknown ids stay out of `access`; `failed` counts those whose read failed,
 * listed in `failedIds`, and the rest are still being read. Failures are this
 * mount's and id set's only: the next mount, id set, sign-in or turning `read`
 * back on reads them again, and `retry` does so now. With `read: false` only
 * answers already cached are reported and nothing is requested. Unmounting, or
 * a new id set, abandons reads still queued.
 */
export function useSessionAccess(
  client: AgorClient | null,
  userId: string | undefined,
  branchIds: string[],
  { read = true }: { read?: boolean } = {}
) {
  const { authGeneration } = useConnectionState();
  const scope = `${userId}:${authGeneration}`;
  const key = branchIds.join(',');
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState({ scope, key, ids: NO_FAILURES });
  const [wasReading, setWasReading] = useState(read);
  // Turning reads back on re-reads the failures, so they stop showing now.
  if (wasReading !== read) {
    setWasReading(read);
    if (read) setFailed({ scope, key, ids: NO_FAILURES });
  }
  // A new id set re-reads every failure, so those show as pending again.
  const failedIds = failed.scope === scope && failed.key === key ? failed.ids : NO_FAILURES;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the reads on retry
  useEffect(() => {
    if (!client || !userId || !key || !read) return;
    const controller = new AbortController();
    for (const id of key.split(',')) {
      readAccess(client, scope, `branch:${id}`, () => canStartSessionsOn(client, id), {
        signal: controller.signal,
      }).then(
        () => setVersion((v) => v + 1),
        () => {
          if (controller.signal.aborted) return;
          setFailed((prev) => ({
            scope,
            key,
            ids: new Set([...(prev.scope === scope && prev.key === key ? prev.ids : []), id]),
          }));
        }
      );
    }
    return () => controller.abort();
  }, [client, userId, scope, key, read, attempt]);
  const retry = useCallback(() => {
    setFailed({ scope, key, ids: NO_FAILURES });
    setAttempt((a) => a + 1);
  }, [scope, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version re-reads the cache after a read settles
  return useMemo(() => {
    const access: Record<string, boolean> = {};
    let failures = 0;
    for (const id of client && userId && key ? key.split(',') : []) {
      const known = peekAccess(client as AgorClient, scope, `branch:${id}`);
      if (known !== undefined) access[id] = known;
      else if (failedIds.has(id)) failures++;
    }
    return { access, failedIds, failed: failures, retry };
  }, [client, userId, scope, key, version, failedIds, retry]);
}
