import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';

const EMPTY: MCPMarketplaceOverview = {
  servers: [],
  attachments: [],
  credentials: [],
  generated_at: new Date(0).toISOString(),
};

export function useMarketplaceOverview(input: {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  authGeneration: number;
  userId?: string;
  role?: string;
}) {
  const { client, connected, connecting, authGeneration, userId, role } = input;
  const ready = Boolean(client && connected && !connecting && userId && role);
  const authority = useMemo(
    () => (ready ? { userId: userId!, role: role!, authGeneration, client } : null),
    [authGeneration, client, ready, role, userId]
  );
  const guard = useAuthorityOperationGuard(
    authority
      ? [authority.userId, authority.role, authority.authGeneration, authority.client]
      : null
  );
  const [loaded, setLoaded] = useState<{
    authority: typeof authority;
    value: MCPMarketplaceOverview;
    successful: boolean;
  }>({ authority: null, value: EMPTY, successful: false });
  const [loading, setLoading] = useState(ready);
  const [loadedError, setLoadedError] = useState<{
    authority: typeof authority;
    value: string | null;
  }>({ authority: null, value: null });
  const requestSequence = useRef(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  // Never render data captured under another identity/role/auth generation,
  // even for the render before effects run. This is the caller-private data
  // boundary; effects only perform I/O and cleanup.
  const overview = loaded.authority === authority ? loaded.value : EMPTY;
  const error = loadedError.authority === authority ? loadedError.value : null;

  const refresh = useCallback(async () => {
    const operation = guard.begin();
    if (!client || !ready || !operation.isCurrent()) return null;
    const request = ++requestSequence.current;
    const isCurrent = () => operation.isCurrent() && requestSequence.current === request;
    const hasSnapshot = loadedRef.current.authority === authority && loadedRef.current.successful;
    // Revalidation is deliberately stale-while-refresh. A table, drawer, or
    // confirmation that was already rendered must not disappear just because
    // focus/visibility or a realtime hint asked for a fresher projection.
    if (!hasSnapshot) setLoading(true);
    setLoadedError({ authority, value: null });
    try {
      const result = (await client
        .service('mcp-marketplace')
        .find()) as unknown as MCPMarketplaceOverview;
      if (!isCurrent()) return null;
      const next = { authority, value: result, successful: true };
      loadedRef.current = next;
      setLoaded(next);
      return result;
    } catch (cause) {
      if (!isCurrent()) return;
      if (!hasSnapshot) {
        const next = { authority, value: EMPTY, successful: false };
        loadedRef.current = next;
        setLoaded(next);
      }
      setLoadedError({
        authority,
        value: cause instanceof Error ? cause.message : 'Could not load Marketplace data',
      });
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [authority, client, guard, ready]);

  useEffect(() => {
    if (!ready) {
      setLoaded({ authority: null, value: EMPTY, successful: false });
      setLoading(false);
      setLoadedError({ authority: null, value: null });
      return;
    }
    void refresh();
  }, [ready, refresh]);

  useEffect(() => {
    if (!client || !ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      requestSequence.current++;
      setLoadedError({ authority, value: null });
      timer = setTimeout(() => void refresh(), 100);
    };
    const invalidate = () => {
      clearTimeout(timer);
      requestSequence.current++;
      // This targeted event is emitted for caller revocation. Unlike ordinary
      // freshness hints it is an explicit authority narrowing, so fail closed.
      const next = { authority, value: EMPTY, successful: false };
      loadedRef.current = next;
      setLoaded(next);
      setLoadedError({ authority, value: null });
      timer = setTimeout(() => void refresh(), 100);
    };
    const services = [
      'mcp-servers',
      'session-mcp-servers',
      'sessions',
      'branches',
      'branches/:id/owners',
      'branches/:id/group-grants',
      'boards',
      'boards/:id/owners',
      'boards/:id/group-grants',
      'groups',
      'group-memberships',
      'users',
      'mcp-member-policy',
    ] as const;
    const events = ['created', 'patched', 'updated', 'removed'] as const;
    for (const path of services) {
      for (const event of events) client.service(path).on(event, schedule);
    }
    client.io.on('oauth:completed', schedule);
    client.io.on('oauth:disconnected', schedule);
    client.io.on('marketplace:invalidated', invalidate);
    const onFocus = schedule;
    const onVisibility = () => document.visibilityState === 'visible' && schedule();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      for (const path of services) {
        for (const event of events) client.service(path).off(event, schedule);
      }
      client.io.off('oauth:completed', schedule);
      client.io.off('oauth:disconnected', schedule);
      client.io.off('marketplace:invalidated', invalidate);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authority, client, ready, refresh]);

  return {
    overview,
    loading: ready && loaded.authority !== authority ? true : loading,
    error,
    refresh,
  };
}
