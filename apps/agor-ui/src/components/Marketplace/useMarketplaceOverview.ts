import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';
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
}) {
  const { client, connected, connecting, authGeneration, userId } = input;
  const ready = Boolean(client && connected && !connecting && userId);
  const guard = useAuthorityOperationGuard(ready ? [userId!, authGeneration, client] : null);
  const [overview, setOverview] = useState<MCPMarketplaceOverview>(EMPTY);
  const [loading, setLoading] = useState(ready);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const operation = guard.begin();
    if (!client || !ready || !operation.isCurrent()) return;
    setLoading(true);
    try {
      const result = await client.service('mcp-marketplace').find();
      if (!operation.isCurrent()) return;
      setOverview(result);
      setError(null);
    } catch (cause) {
      if (!operation.isCurrent()) return;
      setError(cause instanceof Error ? cause.message : 'Could not load Marketplace data');
    } finally {
      if (operation.isCurrent()) setLoading(false);
    }
  }, [client, guard, ready]);

  useEffect(() => {
    if (!ready) {
      setOverview(EMPTY);
      setLoading(false);
      setError(null);
      return;
    }
    void refresh();
  }, [ready, refresh]);

  useEffect(() => {
    if (!client || !ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 40);
    };
    const services = ['mcp-servers', 'session-mcp-servers', 'sessions', 'branches'] as const;
    const events = ['created', 'patched', 'updated', 'removed'] as const;
    for (const path of services) {
      for (const event of events) client.service(path).on(event, schedule);
    }
    client.io.on('oauth:completed', schedule);
    client.io.on('oauth:disconnected', schedule);
    const onFocus = () => void refresh();
    const onVisibility = () => document.visibilityState === 'visible' && void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      for (const path of services) {
        for (const event of events) client.service(path).off(event, schedule);
      }
      client.io.off('oauth:completed', schedule);
      client.io.off('oauth:disconnected', schedule);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [client, ready, refresh]);

  return { overview, loading, error, refresh };
}
