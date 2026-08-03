import type { AgorClient } from '@agor/core/client';
import type { OpenCodeModelCatalog } from '@agor/core/types';
import { useCallback, useEffect, useRef, useState } from 'react';

type CatalogScope = {
  catalog: OpenCodeModelCatalog;
  client: AgorClient;
  catalogEnabled: boolean;
};

export function useOpenCodeModelCatalog(input: {
  client?: AgorClient | null;
  catalogEnabled: boolean;
}) {
  const { client, catalogEnabled } = input;
  const [catalogScope, setCatalogScope] = useState<CatalogScope | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const requestSequence = useRef(0);
  const catalog =
    catalogScope && catalogScope.client === client && catalogScope.catalogEnabled === catalogEnabled
      ? catalogScope.catalog
      : null;

  const refresh = useCallback(async () => {
    if (!client || !catalogEnabled) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setRefreshFailed(false);
    try {
      const next = await client.service('opencode-models').find();
      if (requestSequence.current !== sequence) return;
      setCatalogScope({ catalog: next, client, catalogEnabled });
    } catch {
      if (requestSequence.current !== sequence) return;
      setRefreshFailed(true);
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }, [catalogEnabled, client]);

  useEffect(() => {
    if (!catalogEnabled) {
      requestSequence.current += 1;
      setCatalogScope(null);
      setRefreshFailed(false);
      setLoading(false);
      return;
    }
    // A catalog is valid only for the client/enabled tuple that produced it.
    // Dependency-driven scope changes must not retain a prior user's result;
    // the explicit Refresh action can preserve the current scoped result.
    setCatalogScope(null);
    setRefreshFailed(false);
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [catalogEnabled, refresh]);

  return { catalog, loading, refreshFailed, refresh };
}
