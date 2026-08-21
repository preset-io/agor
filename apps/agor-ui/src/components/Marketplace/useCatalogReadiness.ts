import type { MCPCatalogReadiness } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';
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
  const guard = useAuthorityOperationGuard(
    enabled ? [userId!, authGeneration, client, entryKey!] : null
  );
  const [value, setValue] = useState<MCPCatalogReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const operation = guard.begin();
    if (!client || !entryKey || !enabled || !operation.isCurrent()) return;
    setLoading(true);
    try {
      const next = await client.service('mcp-catalog/readiness').get(entryKey);
      if (!operation.isCurrent()) return;
      setValue(next);
      setError(null);
    } catch (cause) {
      if (!operation.isCurrent()) return;
      setValue(null);
      setError(cause instanceof Error ? cause.message : 'Could not check connection readiness');
    } finally {
      if (operation.isCurrent()) setLoading(false);
    }
  }, [client, enabled, entryKey, guard]);

  useEffect(() => {
    setValue(null);
    setError(null);
    if (enabled) void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!client || !enabled) return;
    const schedule = () => void refresh();
    const service = client.service('mcp-servers');
    for (const event of ['created', 'patched', 'updated', 'removed'] as const) {
      service.on(event, schedule);
    }
    client.io.on('oauth:completed', schedule);
    client.io.on('oauth:disconnected', schedule);
    window.addEventListener('focus', schedule);
    return () => {
      for (const event of ['created', 'patched', 'updated', 'removed'] as const) {
        service.off(event, schedule);
      }
      client.io.off('oauth:completed', schedule);
      client.io.off('oauth:disconnected', schedule);
      window.removeEventListener('focus', schedule);
    };
  }, [client, enabled, refresh]);

  return { readiness: value, loading, error, refresh };
}
