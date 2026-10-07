import type { AgorClient, Branch, Session } from '@agor-live/client';
import { useCallback, useEffect, useRef } from 'react';
import type { DataMaps } from '../store/agorMaps';
import { agorStore, useAgorStore } from '../store/agorStore';
import { createIdReader, type IdReader, rowsOf } from '../store/idReads';
import { captureLoadLifetime } from '../store/loadLifetime';
import { sessionListQuery } from '../store/sessionListQuery';
import { type FillRows, fillOnDemand } from '../store/userScope';
import { usePinnedRows } from './usePinnedRows';

type EnsureKind = 'sessions' | 'branches';

const ENSURE: Record<
  EnsureKind,
  {
    has: (maps: DataMaps, id: string) => boolean;
    ids: (rows: FillRows) => string[];
    read: (client: AgorClient, chunk: string[]) => Promise<FillRows>;
  }
> = {
  sessions: {
    has: (maps, id) => maps.sessionById.has(id),
    ids: (rows) => (rows.sessions ?? []).map((session) => session.session_id),
    read: async (client, chunk) => ({
      sessions: rowsOf<Session>(
        await client.service('sessions').find({
          query: sessionListQuery({
            session_id: { $in: chunk },
            archived: false,
            $limit: chunk.length,
            $count: false,
          }),
        })
      ),
    }),
  },
  branches: {
    has: (maps, id) => maps.branchById.has(id),
    ids: (rows) => (rows.branches ?? []).map((branch) => branch.branch_id),
    read: async (client, chunk) => ({
      branches: rowsOf<Branch>(
        await client.service('branches').find({
          query: { branch_id: { $in: chunk }, archived: false, $limit: chunk.length },
        })
      ),
    }),
  },
};

/**
 * Make sure the store holds the rows of `ids` that a view refers to without
 * global data: the ones it lacks are read by id once first paint settled
 * (`idReads.ts`: chunks, bounded concurrency, capped-backoff retries) and
 * filled with no scope while their pins hold them (a reply after unmount
 * inserts nothing). Archived rows stay unloaded (a fill skips them). An id
 * the server didn't return, or whose every read failed, is not asked for
 * again under this authority while a view still asks for it; an id the store
 * evicts after loading it is read again. With `debounceMs`, a burst of id
 * changes is read once it settles. The ids are pinned while the view is
 * mounted (`usePinnedRows`), so no eviction takes a row it displays.
 */
interface EnsureReader {
  authority: string;
  ids: IdReader;
}

function useEnsureRows(
  kind: EnsureKind,
  client: AgorClient | null | undefined,
  ids: Iterable<string>,
  debounceMs = 0
): void {
  const key = [...new Set(ids)].filter(Boolean).sort().join(',');
  usePinnedRows({ [kind]: key ? key.split(',') : [] });
  const missing = useAgorStore(
    useCallback(
      (s: DataMaps) =>
        key
          ? key
              .split(',')
              .filter((id) => !ENSURE[kind].has(s, id))
              .join(',')
          : '',
      [kind, key]
    )
  );
  const firstPaintSettled = useAgorStore((s) => !s.loading);
  const authority = useAgorStore((s) => s.dataAuthority);
  const reader = useRef<EnsureReader | null>(null);

  useEffect(() => () => reader.current?.ids.dispose(), []);

  useEffect(() => {
    // What the reader knows follows current demand: an id no view asks for
    // any more is forgotten (absent included), so it never grows with history.
    const wanted = new Set(key.split(','));
    const known = reader.current
      ? [...reader.current.ids.absent, ...reader.current.ids.failed]
      : [];
    reader.current?.ids.forget(known.filter((id) => !wanted.has(id)));
    if (!client || !missing || !firstPaintSettled || !authority) return;
    const run = () => {
      let current = reader.current;
      if (current?.authority !== authority) {
        reader.current?.ids.dispose();
        const has = (id: string) => ENSURE[kind].has(agorStore.getState(), id);
        const next: EnsureReader = {
          authority,
          ids: createIdReader({
            // Absent only when the server didn't return it: a returned row
            // the store lacks (unpinned meanwhile, or removed live) is not.
            read: async (chunk) => {
              const rows = await fillOnDemand(() => ENSURE[kind].read(client, chunk));
              return rows && new Set([...ENSURE[kind].ids(rows), ...chunk.filter(has)]);
            },
            // A cancelled read is sent again under the lifetime that replaced it.
            isCurrent: () => reader.current === next && !!captureLoadLifetime(),
            retry: (chunk) => chunk.filter((id) => !has(id)),
          }),
        };
        reader.current = next;
        current = next;
      }
      const read = current.ids;
      read.queue(missing.split(',').filter((id) => !read.absent.has(id) && !read.failed.has(id)));
    };
    if (!debounceMs) {
      run();
      return;
    }
    const timer = setTimeout(run, debounceMs);
    return () => clearTimeout(timer);
  }, [kind, key, client, missing, firstPaintSettled, authority, debounceMs]);
}

/** `useEnsureRows` for sessions (`session_id $in`, lean rows). */
export const useEnsureSessions = (
  client: AgorClient | null | undefined,
  ids: Iterable<string>,
  debounceMs?: number
) => useEnsureRows('sessions', client, ids, debounceMs);

/** `useEnsureRows` for branches (`branch_id $in`). */
export const useEnsureBranches = (
  client: AgorClient | null | undefined,
  ids: Iterable<string>,
  debounceMs?: number
) => useEnsureRows('branches', client, ids, debounceMs);
