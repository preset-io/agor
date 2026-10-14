import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgorStore } from '../store/agorStore';
import { idReadRetryDelayMs, MAX_ID_READ_ATTEMPTS } from '../store/idReads';
import {
  authorityIdentity,
  captureLoadLifetime,
  isLoadLifetimeCurrent,
} from '../store/loadLifetime';
import { debounceWithMaxWait } from '../utils/debounceWithMaxWait';

export interface ServerReader<T> {
  /** Read again, debounced with a bounded wait (realtime events). */
  invalidate: () => void;
  /** Read again now. */
  refresh: () => void;
  /** Update the data in place; replayed over the reply of a read in flight. */
  patch: (update: (data: T) => T) => void;
}

interface ReadState<T> {
  key: string | null;
  identity: string | null;
  data: T | undefined;
}

const EMPTY: ReadState<never> = { key: null, identity: null, data: undefined };

/**
 * Display data the store doesn't hold, read from the daemon for `key` (`null`
 * reads nothing and drops the data). One read controller per key and
 * authority:
 * - at most one read in flight; a read requested meanwhile follows it;
 * - a reply lands only while its controller and load lifetime are current, so
 *   a reply for an older key, an earlier opening, or another authority never
 *   lands;
 * - `subscribe` wires the realtime events that invalidate the data (debounced,
 *   with a bounded wait) or patch it in place;
 * - a failed read retries with the user scope's capped backoff, a bounded
 *   number of times.
 *
 * Data read for another user is never shown. With `keepPrevious`, the last
 * key's data stays visible while the new key loads (a table page).
 */
export function useServerRead<T>(
  client: AgorClient | null | undefined,
  key: string | null,
  read: (client: AgorClient) => Promise<T>,
  options: {
    subscribe?: (client: AgorClient, reader: ServerReader<T>) => () => void;
    keepPrevious?: boolean;
  } = {}
): { data: T | undefined; loading: boolean } & Omit<ServerReader<T>, 'patch'> {
  const authority = useAgorStore((s) => s.dataAuthority);
  const [state, setState] = useState<ReadState<T>>(EMPTY);
  const [loading, setLoading] = useState(false);
  const readRef = useRef(read);
  readRef.current = read;
  const subscribeRef = useRef(options.subscribe);
  subscribeRef.current = options.subscribe;
  const readerRef = useRef<ServerReader<T> | null>(null);

  useEffect(() => {
    if (!client || key === null) {
      setState((s) => (s === EMPTY ? s : EMPTY));
      setLoading(false);
      return;
    }
    if (!authority) return; // reads wait for a valid authority
    const identity = authorityIdentity(authority);
    setState((s) => (s.identity && s.identity !== identity ? EMPTY : s));
    let disposed = false;
    let inflight = false;
    let dirty = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Patches since the read in flight started, replayed over its reply.
    let patches: Array<(data: T) => T> = [];

    const run = async (): Promise<void> => {
      if (disposed) return;
      if (inflight) {
        dirty = true;
        return;
      }
      const lifetime = captureLoadLifetime();
      if (!lifetime) return;
      // This read covers a re-read still waiting in its debounce or backoff.
      debounce.cancel();
      clearTimeout(retryTimer);
      inflight = true;
      dirty = false;
      patches = [];
      setLoading(true);
      try {
        const reply = await readRef.current(client);
        if (disposed) return;
        // Cancelled under the same authority (a store remount): read again.
        if (!isLoadLifetimeCurrent(lifetime)) {
          dirty = true;
          return;
        }
        attempts = 0;
        const data = patches.reduce<T>((current, update) => update(current), reply);
        setState({ key, identity, data });
      } catch (err) {
        if (disposed) return;
        console.warn('[server-read] read failed:', err);
        attempts += 1;
        if (attempts < MAX_ID_READ_ATTEMPTS) {
          retryTimer = setTimeout(() => void run(), idReadRetryDelayMs(attempts));
        }
      } finally {
        inflight = false;
        patches = [];
        if (!disposed) {
          setLoading(false);
          if (dirty) void run();
        }
      }
    };
    const debounce = debounceWithMaxWait(() => void run());
    const reader: ServerReader<T> = {
      invalidate: debounce.request,
      refresh: () => void run(),
      patch: (update) => {
        if (disposed) return;
        if (inflight) patches.push(update);
        setState((s) =>
          s.data !== undefined && s.identity === identity ? { ...s, data: update(s.data) } : s
        );
      },
    };
    readerRef.current = reader;
    const unsubscribe = subscribeRef.current?.(client, reader);
    void run();
    return () => {
      disposed = true;
      debounce.cancel();
      clearTimeout(retryTimer);
      unsubscribe?.();
      if (readerRef.current === reader) readerRef.current = null;
    };
  }, [client, key, authority]);

  const invalidate = useCallback(() => readerRef.current?.invalidate(), []);
  const refresh = useCallback(() => readerRef.current?.refresh(), []);
  const visible =
    state.data !== undefined &&
    key !== null &&
    (state.key === key || options.keepPrevious) &&
    (!authority || authorityIdentity(authority) === state.identity);
  return { data: visible ? state.data : undefined, loading, invalidate, refresh };
}
