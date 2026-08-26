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
  }>({ authority: null, value: EMPTY });
  const [loading, setLoading] = useState(ready);
  const [loadedError, setLoadedError] = useState<{
    authority: typeof authority;
    value: string | null;
  }>({ authority: null, value: null });
  const requestSequence = useRef(0);

  // Never render data captured under another identity/role/auth generation,
  // even for the render before effects run. This is the caller-private data
  // boundary; effects only perform I/O and cleanup.
  const overview = loaded.authority === authority ? loaded.value : EMPTY;
  const error = loadedError.authority === authority ? loadedError.value : null;

  const refresh = useCallback(async () => {
    const operation = guard.begin();
    if (!client || !ready || !operation.isCurrent()) return;
    const request = ++requestSequence.current;
    const isCurrent = () => operation.isCurrent() && requestSequence.current === request;
    setLoading(true);
    setLoadedError({ authority, value: null });
    try {
      const result = await client.service('mcp-marketplace').find();
      if (!isCurrent()) return;
      setLoaded({ authority, value: result });
    } catch (cause) {
      if (!isCurrent()) return;
      setLoaded({ authority, value: EMPTY });
      setLoadedError({
        authority,
        value: cause instanceof Error ? cause.message : 'Could not load Marketplace data',
      });
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [authority, client, guard, ready]);

  useEffect(() => {
    if (!ready) {
      setLoaded({ authority: null, value: EMPTY });
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
      // Visibility can only narrow while this read is in flight. Fail closed
      // immediately, then coalesce event bursts into one authoritative read.
      setLoaded({ authority, value: EMPTY });
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
    client.io.on('marketplace:invalidated', schedule);
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
      client.io.off('marketplace:invalidated', schedule);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authority, client, ready, refresh]);

  return { overview, loading, error, refresh };
}
