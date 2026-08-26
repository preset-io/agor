import type { MCPCatalogReadiness } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';

export function useCatalogReadiness(input: {
  client: AgorClient | null;
  entryKey?: string;
  ready: boolean;
  authGeneration: number;
  userId?: string;
}) {
  const { client, entryKey, ready, authGeneration, userId } = input;
  const enabled = Boolean(client && ready && userId && entryKey);
  const authority = useMemo(
    () => (enabled ? { userId: userId!, authGeneration, client, entryKey: entryKey! } : null),
    [authGeneration, client, enabled, entryKey, userId]
  );
  const guard = useAuthorityOperationGuard(
    authority
      ? [authority.userId, authority.authGeneration, authority.client, authority.entryKey]
      : null
  );
  const [loaded, setLoaded] = useState<{
    authority: typeof authority;
    value: MCPCatalogReadiness | null;
    loading: boolean;
    error: string | null;
  }>({ authority: null, value: null, loading: false, error: null });
  const requestSequence = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A debounce window is not permission to keep a previously-authoritative
  // answer interactive. Identity/entry changes and invalidations become an
  // immediate loading/unknown state; only the network request is coalesced.
  const isCurrentAuthority = loaded.authority === authority;
  const value = isCurrentAuthority ? loaded.value : null;
  const error = isCurrentAuthority ? loaded.error : null;
  const loading = Boolean(enabled && (!isCurrentAuthority || loaded.loading));

  const refresh = useCallback(async () => {
    const operation = guard.begin();
    if (!client || !entryKey || !enabled || !operation.isCurrent()) return;
    const request = ++requestSequence.current;
    const isCurrent = () => operation.isCurrent() && requestSequence.current === request;
    setLoaded({ authority, value: null, loading: true, error: null });
    try {
      const next = await client.service('mcp-catalog/readiness').get(entryKey);
      if (!isCurrent()) return;
      setLoaded({ authority, value: next, loading: false, error: null });
    } catch (cause) {
      if (!isCurrent()) return;
      setLoaded({
        authority,
        value: null,
        loading: false,
        error: cause instanceof Error ? cause.message : 'Could not check connection readiness',
      });
    }
  }, [authority, client, enabled, entryKey, guard]);

  useEffect(() => {
    requestSequence.current++;
    clearTimeout(debounceTimer.current);
    if (!enabled) {
      setLoaded({ authority: null, value: null, loading: false, error: null });
      return;
    }
    setLoaded({ authority, value: null, loading: true, error: null });
    // Drawer switches and rapid open/close gestures should not issue a request
    // for every intermediate entry.
    debounceTimer.current = setTimeout(() => void refresh(), 100);
    return () => clearTimeout(debounceTimer.current);
  }, [authority, enabled, refresh]);

  useEffect(() => {
    if (!client || !enabled) return;
    const schedule = () => {
      clearTimeout(debounceTimer.current);
      requestSequence.current++;
      // Fail closed synchronously while the invalidation burst is debounced.
      setLoaded({ authority, value: null, loading: true, error: null });
      debounceTimer.current = setTimeout(() => void refresh(), 100);
    };
    const service = client.service('mcp-servers');
    for (const event of ['created', 'patched', 'updated', 'removed'] as const) {
      service.on(event, schedule);
    }
    client.io.on('oauth:completed', schedule);
    client.io.on('oauth:disconnected', schedule);
    client.io.on('marketplace:invalidated', schedule);
    window.addEventListener('focus', schedule);
    return () => {
      clearTimeout(debounceTimer.current);
      for (const event of ['created', 'patched', 'updated', 'removed'] as const) {
        service.off(event, schedule);
      }
      client.io.off('oauth:completed', schedule);
      client.io.off('oauth:disconnected', schedule);
      client.io.off('marketplace:invalidated', schedule);
      window.removeEventListener('focus', schedule);
    };
  }, [authority, client, enabled, refresh]);

  return { readiness: value, loading, error, refresh };
}
